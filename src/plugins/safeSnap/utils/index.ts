import { isAddress } from '@ethersproject/address';
import { JsonRpcProvider } from '@ethersproject/providers';
import { keccak256 } from '@ethersproject/solidity';
import memoize from 'lodash/memoize';

import SafeSnapPlugin, { MULTI_SEND_VERSION } from '../index';
import { createMultiSendTx, getMultiSend } from './multiSend';
import { SafeTransaction, SafeExecutionData } from '@/helpers/interfaces';
import getProvider from '@snapshot-labs/snapshot.js/src/utils/provider';
import { sleep } from '@snapshot-labs/snapshot.js/src/utils';
import networks from '@snapshot-labs/snapshot.js/src/networks.json';

import { getInstance } from '@snapshot-labs/lock/plugins/vue3';

declare let window: any;

export const mustBeEthereumAddress = memoize((address: string) => {
  const startsWith0x = address?.startsWith('0x');
  const isValidAddress = isAddress(address);
  return startsWith0x && isValidAddress;
});

export const mustBeEthereumContractAddress = memoize(
  async (network: string, address: string) => {
    const provider = getProvider(network) as JsonRpcProvider;
    const contractCode = await provider.getCode(address);

    return (
      contractCode && contractCode.replace('0x', '').replace(/0/g, '') !== ''
    );
  },
  (url, contractAddress) => `${url}_${contractAddress}`
);

export function formatBatchTransaction(
  batch: SafeTransaction[],
  nonce: number,
  multiSendAddress: string
): SafeTransaction | null {
  if (!batch.every(x => x)) return null;
  if (batch.length === 1) {
    return { ...batch[0], nonce: nonce.toString() };
  }
  return createMultiSendTx(batch, nonce, multiSendAddress);
}

export function createBatch(
  module: string,
  chainId: number,
  nonce: number,
  txs: SafeTransaction[],
  multiSendAddress: string
) {
  const mainTransaction = formatBatchTransaction(txs, nonce, multiSendAddress);
  const hash = mainTransaction
    ? getBatchHash(module, chainId, mainTransaction)
    : null;
  return {
    hash,
    nonce,
    mainTransaction,
    transactions: txs
  };
}

export function getBatchHash(
  module: string,
  chainId: number,
  transaction: SafeTransaction
) {
  try {
    const safeSnap = new SafeSnapPlugin();
    const hashes = safeSnap.calcTransactionHashes(chainId, module, [
      transaction
    ]);
    return hashes[0];
  } catch (err) {
    console.warn('invalid batch hash', err);
    return null;
  }
}

export function getSafeHash(safe: SafeExecutionData) {
  const hashes = safe.txs.map(batch => batch.hash);
  const valid = hashes.every(hash => hash);
  if (!valid || !hashes.length) return null;
  return keccak256(['bytes32[]'], [hashes]);
}

export function validateSafeData(safe) {
  return (
    safe.txs.length === 0 ||
    safe.txs
      .map(batch => batch.transactions)
      .flat()
      .every(tx => tx)
  );
}

export function isValidInput(input) {
  return input.safes.every(validateSafeData);
}

export function coerceConfig(config, network) {
  if (config.safes) {
    return {
      ...config,
      safes: config.safes.map(safe => {
        if (safe.realityAddress) {
          safe.moduleAddress = safe.realityAddress;
          safe.moduleType = 'reality';
          delete safe.realityAddress;
        }
        const _network = safe.network || network;
        const multiSendAddress =
          safe.multiSendAddress || getMultiSend(_network);
        const txs = (safe.txs || []).map((batch, nonce) => {
          const oldMultiSendAddress =
            safe.multiSendAddress ||
            getMultiSend(_network, MULTI_SEND_VERSION.V1_1_1) ||
            getMultiSend(_network, MULTI_SEND_VERSION.V1_3_0);
          if (Array.isArray(batch)) {
            // Assume old config
            return createBatch(
              safe.moduleAddress,
              _network,
              nonce,
              batch,
              oldMultiSendAddress
            );
          }

          if (!batch.mainTransaction) {
            return {
              ...batch,
              mainTransaction: formatBatchTransaction(
                batch.transactions,
                batch.nonce,
                oldMultiSendAddress
              )
            };
          }
          return batch;
        });
        const sanitizedSafe = {
          ...safe,
          txs,
          multiSendAddress
        };
        return {
          ...sanitizedSafe,
          hash: sanitizedSafe.hash ?? getSafeHash(sanitizedSafe)
        };
      })
    };
  }

  // map legacy config to new format
  return {
    safes: [
      {
        network,
        moduleAddress: config.address,
        moduleType: 'reality',
        multiSendAddress:
          getMultiSend(network, MULTI_SEND_VERSION.V1_1_1) ||
          getMultiSend(network, MULTI_SEND_VERSION.V1_3_0)
      }
    ]
  };
}

export async function fetchTextSignatures(
  methodSignature: string
): Promise<string[]> {
  const url = new URL('/api/v1/signatures', 'https://www.4byte.directory');
  url.searchParams.set('hex_signature', methodSignature);
  url.searchParams.set('ordering', 'created_at');
  const response = await fetch(url.toString());
  const { results } = await response.json();
  return results.map(signature => signature.text_signature);
}

export async function ensureRightNetwork(chainId) {
  const chainIdInt = parseInt(chainId);
  const connectedToChainId = getInstance().provider.value?.chainId;
  if (connectedToChainId === chainIdInt) return; // already on right chain

  if (!window.ethereum || !getInstance().provider.value?.isMetaMask) {
    // we cannot switch automatically
    throw new Error(
      `Connected to wrong chain #${connectedToChainId}, required: #${chainId}`
    );
  }

  const network = networks[chainId];
  const chainIdHex = `0x${chainIdInt.toString(16)}`;

  try {
    // check if the chain to connect to is installed
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }] // chainId must be in hexadecimal numbers
    });
  } catch (error: any) {
    // This error code indicates that the chain has not been added to MetaMask. Let's add it.
    if (error.code === 4902) {
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: chainIdHex,
              chainName: network.name,
              rpcUrls: network.rpc,
              blockExplorerUrls: [network.explorer]
            }
          ]
        });
      } catch (addError) {
        console.error(addError);
      }
    }
    console.error(error);
  }

  await sleep(1e3); // somehow the switch does not take immediate effect :/
  if (window.ethereum.chainId !== chainIdHex) {
    throw new Error(
      `Could not switch to the right chain on MetaMask (required: ${chainIdHex}, active: ${window.ethereum.chainId})`
    );
  }
}
