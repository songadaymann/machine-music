// payment.ts -- Verify ETH payments on Base L2 via raw JSON-RPC
// No ethers.js/viem — just fetch + JSON-RPC.

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const PROTOCOL_ADDRESS = (process.env.PROTOCOL_ADDRESS || "").toLowerCase();

// Minimum payment amounts in wei (as bigint)
export const MIN_PROMPT_WEI = 10_000_000_000_000_000n; // 0.01 ETH
export const MIN_STORM_WEI = 5_000_000_000_000_000_000n; // 5 ETH

// Double-spend prevention
const processedTxHashes = new Set<string>();

export interface PaymentResult {
  valid: boolean;
  error?: string;
  from?: string;
  value?: string;
}

async function jsonRpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(BASE_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`rpc_http_${response.status}`);
  }

  const data = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (data.error) {
    throw new Error(`rpc_error: ${data.error.message}`);
  }

  return data.result;
}

interface TxReceipt {
  status: string; // "0x1" = success
  from: string;
  to: string;
  transactionHash: string;
  blockNumber: string;
}

interface TxData {
  from: string;
  to: string;
  value: string; // hex wei
  hash: string;
}

export async function verifyPayment(
  txHash: string,
  expectedSender: string,
  minWei: bigint
): Promise<PaymentResult> {
  if (!PROTOCOL_ADDRESS) {
    return { valid: false, error: "protocol_address_not_configured" };
  }

  const normalizedHash = txHash.toLowerCase();

  // Double-spend check
  if (processedTxHashes.has(normalizedHash)) {
    return { valid: false, error: "tx_already_processed" };
  }

  try {
    // Fetch receipt to confirm the tx succeeded
    const receipt = (await jsonRpc("eth_getTransactionReceipt", [txHash])) as TxReceipt | null;
    if (!receipt) {
      return { valid: false, error: "tx_not_found" };
    }

    if (receipt.status !== "0x1") {
      return { valid: false, error: "tx_reverted" };
    }

    // Fetch the transaction data for value + addresses
    const tx = (await jsonRpc("eth_getTransactionByHash", [txHash])) as TxData | null;
    if (!tx) {
      return { valid: false, error: "tx_data_not_found" };
    }

    // Verify recipient is our protocol address
    if (tx.to?.toLowerCase() !== PROTOCOL_ADDRESS) {
      return { valid: false, error: "wrong_recipient" };
    }

    // Verify sender matches the wallet session
    if (tx.from?.toLowerCase() !== expectedSender.toLowerCase()) {
      return { valid: false, error: "sender_mismatch" };
    }

    // Verify value meets minimum
    const value = BigInt(tx.value);
    if (value < minWei) {
      return {
        valid: false,
        error: "insufficient_value",
        value: tx.value,
      };
    }

    // Mark as processed (prevents double-spend)
    processedTxHashes.add(normalizedHash);

    return {
      valid: true,
      from: tx.from.toLowerCase(),
      value: tx.value,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return { valid: false, error: message };
  }
}

export function isPaymentConfigured(): boolean {
  return PROTOCOL_ADDRESS.length > 0;
}

export function resetProcessedTxHashes(): void {
  processedTxHashes.clear();
}
