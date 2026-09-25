/**
 * The agent's own wallet. The key stays in this process: it signs locally and
 * sends to a BSC node. Nothing that can move money ever reaches our API.
 *
 *   MM_PRIVATE_KEY   the agent's wallet.
 *   MM_WALLET        without a key: an address to DRY RUN as (it can never send).
 *   Neither: read-only (quotes, tokens, launches).
 *   MM_RPC_URL       the node to send through. Unset: a public node for the
 *                    chain the API is on.
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';

const PUBLIC_RPC = { 56: 'https://bsc-dataseed.bnbchain.org', 97: 'https://bsc-testnet-rpc.publicnode.com' };

export function agentWallet({ key = process.env.MM_PRIVATE_KEY, watch = process.env.MM_WALLET, rpcUrl = process.env.MM_RPC_URL, chainId } = {}) {
  if (!key && !watch) return null;
  const url = rpcUrl ?? PUBLIC_RPC[chainId];
  if (!url) throw new Error(`No node for chain ${chainId}: set MM_RPC_URL.`);
  const provider = new JsonRpcProvider(url, chainId, { staticNetwork: true });
  if (!key) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(watch)) throw new Error('MM_WALLET must be a 0x address.');
    return {
      address: watch.toLowerCase(),
      async send() { throw new Error('MM_WALLET can only dry run: set MM_PRIVATE_KEY to send.'); },
      async balanceOf(token, decimals = 18) {
        return { raw: await new Contract(token, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(watch), decimals };
      },
    };
  }
  const signer = new Wallet(key.startsWith('0x') ? key : `0x${key}`, provider);
  return {
    address: signer.address.toLowerCase(),
    /** Sign, send and wait for one built transaction. Throws if it reverts. */
    async send(tx) {
      if (Number(tx.chainId) !== chainId) throw new Error(`The transaction is for chain ${tx.chainId}; this wallet is on ${chainId}.`);
      const sent = await signer.sendTransaction({
        to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), chainId,
        ...(tx.gas ? { gasLimit: BigInt(tx.gas) } : {}),
      });
      const receipt = await sent.wait(1, 120_000);
      if (!receipt || receipt.status !== 1) throw new Error(`Transaction ${sent.hash} reverted.`);
      return sent.hash;
    },
    /** What this wallet holds of `token`: the raw amount and its decimals. */
    async balanceOf(token, decimals = 18) {
      const raw = await new Contract(token, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(signer.address);
      return { raw, decimals };
    },
  };
}
