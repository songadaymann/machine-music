// wallet.js -- Wallet connect via Reown AppKit (web components, no React)

const API_BASE = '';

let appKit = null;
let connected = false;
let currentAddress = null;
let sessionToken = null;

// --- Public API ---

export function getAddress() {
    return currentAddress;
}

export function getSessionToken() {
    return sessionToken;
}

export function isConnected() {
    return connected && !!currentAddress;
}

export async function initWallet(projectId) {
    if (!projectId) {
        console.warn('[wallet] No WALLETCONNECT_PROJECT_ID — wallet connect disabled');
        return false;
    }

    try {
        const { createAppKit } = await import('https://esm.sh/@reown/appkit@1.6.8');
        const { EthersAdapter } = await import('https://esm.sh/@reown/appkit-adapter-ethers@1.6.8');

        const metadata = {
            name: 'SynthMob',
            description: 'Multiplayer music composition arena',
            url: window.location.origin,
            icons: [],
        };

        const base = {
            chainId: 8453,
            name: 'Base',
            currency: 'ETH',
            explorerUrl: 'https://basescan.org',
            rpcUrl: 'https://mainnet.base.org',
        };

        appKit = createAppKit({
            adapters: [new EthersAdapter()],
            networks: [base],
            metadata,
            projectId,
            features: {
                analytics: false,
            },
        });

        // Listen for account changes
        appKit.subscribeAccount(handleAccountChange);

        console.log('[wallet] AppKit initialized');
        return true;
    } catch (err) {
        console.error('[wallet] Failed to initialize AppKit:', err);
        return false;
    }
}

export async function connectWallet() {
    if (!appKit) {
        console.warn('[wallet] AppKit not initialized');
        return null;
    }

    try {
        await appKit.open();
        return currentAddress;
    } catch (err) {
        console.error('[wallet] Connect failed:', err);
        return null;
    }
}

export async function disconnectWallet() {
    if (!appKit) return;
    try {
        await appKit.disconnect();
    } catch (err) {
        console.error('[wallet] Disconnect failed:', err);
    }
    connected = false;
    currentAddress = null;
    sessionToken = null;
}

export async function signMessage(message) {
    if (!appKit) throw new Error('AppKit not initialized');

    const provider = appKit.getWalletProvider();
    if (!provider) throw new Error('No wallet provider');

    const accounts = await provider.request({ method: 'eth_accounts' });
    if (!accounts || accounts.length === 0) throw new Error('No accounts');

    const signature = await provider.request({
        method: 'personal_sign',
        params: [message, accounts[0]],
    });

    return signature;
}

// Authenticate with server: get nonce, sign, verify, get session token
export async function authenticate() {
    if (!currentAddress) throw new Error('Wallet not connected');

    // 1. Get nonce
    const nonceRes = await fetch(`${API_BASE}/api/auth/nonce`);
    if (!nonceRes.ok) throw new Error('Failed to get nonce');
    const { nonce } = await nonceRes.json();

    // 2. Build and sign message
    const message = `Sign in to SynthMob\n\nNonce: ${nonce}`;
    const signature = await signMessage(message);

    // 3. Verify with server
    const verifyRes = await fetch(`${API_BASE}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: currentAddress, signature, nonce }),
    });

    if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.error || 'Verification failed');
    }

    const result = await verifyRes.json();
    sessionToken = result.token;
    console.log('[wallet] Authenticated:', result.address);
    return result;
}

// --- Callbacks ---

let onConnectCallback = null;
let onDisconnectCallback = null;

export function onConnect(cb) {
    onConnectCallback = cb;
}

export function onDisconnect(cb) {
    onDisconnectCallback = cb;
}

// --- Internal ---

function handleAccountChange(account) {
    if (account?.address && account?.isConnected) {
        const addr = account.address;
        if (addr !== currentAddress) {
            currentAddress = addr;
            connected = true;
            sessionToken = null; // re-auth needed on address change
            console.log('[wallet] Connected:', addr);
            if (onConnectCallback) onConnectCallback(addr);
        }
    } else {
        if (connected) {
            connected = false;
            currentAddress = null;
            sessionToken = null;
            console.log('[wallet] Disconnected');
            if (onDisconnectCallback) onDisconnectCallback();
        }
    }
}
