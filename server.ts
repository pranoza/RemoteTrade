import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import dns from 'dns';
import https from 'https';
import crypto from 'crypto';
import dotenv from 'dotenv';
import WebSocket from 'ws';

// Ensure IPv4 is preferred inside Docker containers (resolves 'fetch failed' IPv6 routing issues on VPS)
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Ignore fallback
}

dotenv.config();

// cTrader Open API Payload Type Constants
const PAYLOAD_TYPES = {
  HEARTBEAT_EVENT: 51,
  APPLICATION_AUTH_REQ: 2100,
  APPLICATION_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  NEW_ORDER_REQ: 2106,
  CANCEL_ORDER_REQ: 2108,
  AMEND_ORDER_REQ: 2109,
  AMEND_POSITION_SLTP_REQ: 2110,
  CLOSE_POSITION_REQ: 2111,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  SYMBOL_BY_ID_REQ: 2116,
  SYMBOL_BY_ID_RES: 2117,
  TRADER_REQ: 2121,
  TRADER_RES: 2122,
  RECONCILE_REQ: 2124,
  RECONCILE_RES: 2125,
  EXECUTION_EVENT: 2126,
  ORDER_ERROR_EVENT: 2132,
  OA_ERROR_RES: 2142,
  GET_ACCOUNTS_BY_TOKEN_REQ: 2149,
  GET_ACCOUNTS_BY_TOKEN_RES: 2150,
} as const;

export interface CTraderAccount {
  ctidTraderAccountId: number;
  isLive: boolean;
  traderLogin: number;
  brokerTitleShort?: string;
  balance?: number;
  currency?: string;
  leverage?: number;
  freeMargin?: number;
}

export interface CTraderSymbol {
  symbolId: number;
  symbolName: string;
  digits: number;
  pipPosition: number;
  lotSize: number;
  minVolume: number;
  stepVolume: number;
  description: string;
  referencePrice: number;
}

export interface CTraderPosition {
  positionId: number;
  symbolId: number;
  symbolName: string;
  tradeSide: 'BUY' | 'SELL';
  volumeLots: number;
  volumeProtocol: number;
  entryPrice: number;
  currentPrice: number;
  grossProfit: number;
  netProfit: number;
  pips: number;
  stopLoss: number | null;
  takeProfit: number | null;
  swap: number;
  commission: number;
  comment: string;
  openTimestamp: number;
}

export function computePositionPnL(
  pos: {
    symbolId: number;
    symbolName?: string;
    tradeSide: 'BUY' | 'SELL';
    volumeLots: number;
    entryPrice: number;
    commission?: number;
    swap?: number;
  },
  symbol?: CTraderSymbol,
  overridePrice?: number
) {
  const currentPrice = overridePrice !== undefined && overridePrice > 0
    ? overridePrice
    : (symbol?.referencePrice ?? pos.entryPrice);
  const priceDiff = pos.tradeSide === 'BUY'
    ? currentPrice - pos.entryPrice
    : pos.entryPrice - currentPrice;

  const upper = (symbol?.symbolName || pos.symbolName || '').toUpperCase();
  let unitsPerLot = 100_000;
  if (upper.includes('XAU')) unitsPerLot = 100;
  else if (upper.includes('XAG')) unitsPerLot = 5000;
  else if (
    upper.includes('BTC') ||
    upper.includes('ETH') ||
    upper.includes('US30') ||
    upper.includes('NAS') ||
    upper.includes('USTEC') ||
    upper.includes('US500') ||
    upper.includes('DE40')
  ) {
    unitsPerLot = 1;
  }

  const grossProfit = Number((priceDiff * pos.volumeLots * unitsPerLot).toFixed(2));
  const netProfit = Number((grossProfit + (pos.commission || 0) + (pos.swap || 0)).toFixed(2));

  const pipMultiplier = symbol?.pipPosition !== undefined
    ? Math.pow(10, symbol.pipPosition)
    : (symbol?.digits ? Math.pow(10, symbol.digits - 1) : 10000);
  const pips = Number((priceDiff * pipMultiplier).toFixed(1));

  return {
    currentPrice,
    grossProfit,
    netProfit,
    pips,
  };
}

export interface CTraderPendingOrder {
  orderId: number;
  symbolId: number;
  symbolName: string;
  orderType: 'LIMIT' | 'STOP';
  tradeSide: 'BUY' | 'SELL';
  volumeLots: number;
  volumeProtocol: number;
  limitPrice: number | null;
  stopPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  comment: string;
  openTimestamp: number;
}

const DEFAULT_SYMBOLS: CTraderSymbol[] = [
  { symbolId: 1, symbolName: 'EURUSD', digits: 5, pipPosition: 4, lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000, description: 'Euro vs US Dollar', referencePrice: 1.08450 },
  { symbolId: 2, symbolName: 'GBPUSD', digits: 5, pipPosition: 4, lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000, description: 'Great Britain Pound vs US Dollar', referencePrice: 1.29620 },
  { symbolId: 4, symbolName: 'USDJPY', digits: 3, pipPosition: 2, lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000, description: 'US Dollar vs Japanese Yen', referencePrice: 152.340 },
  { symbolId: 41, symbolName: 'XAUUSD', digits: 2, pipPosition: 1, lotSize: 10_000, minVolume: 100, stepVolume: 100, description: 'Spot Gold vs US Dollar', referencePrice: 2745.80 },
  { symbolId: 5, symbolName: 'AUDUSD', digits: 5, pipPosition: 4, lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000, description: 'Australian Dollar vs US Dollar', referencePrice: 0.65820 },
  { symbolId: 6, symbolName: 'USDCAD', digits: 5, pipPosition: 4, lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000, description: 'US Dollar vs Canadian Dollar', referencePrice: 1.38910 },
  { symbolId: 100, symbolName: 'BTCUSD', digits: 2, pipPosition: 0, lotSize: 100, minVolume: 1, stepVolume: 1, description: 'Bitcoin vs US Dollar', referencePrice: 68450.00 },
  { symbolId: 101, symbolName: 'US30', digits: 1, pipPosition: 0, lotSize: 100, minVolume: 100, stepVolume: 100, description: 'Wall Street 30 Index', referencePrice: 42180.5 },
];

const DEFAULT_LOT_SIZE = 10_000_000;

function lotsToProtocolVolume(lots: number, symbol?: CTraderSymbol): number {
  const lotSize = symbol?.lotSize && symbol.lotSize > 0 ? symbol.lotSize : DEFAULT_LOT_SIZE;
  const step = symbol?.stepVolume && symbol.stepVolume > 0 ? symbol.stepVolume : Math.max(1, Math.round(lotSize / 100));
  const minVol = symbol?.minVolume && symbol.minVolume > 0 ? symbol.minVolume : step;
  const raw = Math.round((lots * lotSize) / step) * step;
  return Math.max(minVol, raw);
}

function protocolVolumeToLots(volume: number, symbol?: CTraderSymbol): number {
  const lotSize = symbol?.lotSize && symbol.lotSize > 0 ? symbol.lotSize : DEFAULT_LOT_SIZE;
  return Number((volume / lotSize).toFixed(2));
}

function inferDefaultLotSize(symbolName: string): number {
  const upper = symbolName.toUpperCase();
  if (upper.includes('XAU')) return 10_000; // 100 oz * 100 cents
  if (upper.includes('XAG')) return 500_000; // 5000 oz * 100 cents
  if (upper.includes('BTC') || upper.includes('ETH') || upper.includes('US30') || upper.includes('NAS') || upper.includes('USTEC') || upper.includes('DE40') || upper.includes('US500')) {
    return 100;
  }
  return DEFAULT_LOT_SIZE;
}

const PRIORITY_SYMBOLS = [
  'EURUSD',
  'XAUUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'USDCAD',
  'USDCHF',
  'NZDUSD',
  'EURGBP',
  'EURJPY',
  'GBPJPY',
  'BTCUSD',
  'ETHUSD',
  'US30',
  'USTEC',
  'NAS100',
  'US500',
  'DE40',
];

class CTraderManager {
  private configPath: string = path.join(process.cwd(), '.ctrader_config.json');
  private clientId: string = process.env.CTRADER_CLIENT_ID || '';
  private clientSecret: string = process.env.CTRADER_CLIENT_SECRET || '';
  private accessToken: string = process.env.CTRADER_ACCESS_TOKEN || '';
  private mode: 'live_api' | 'sandbox' = (process.env.CTRADER_ACCESS_TOKEN || '') ? 'live_api' : 'sandbox';
  private accounts: CTraderAccount[] = [];
  private selectedAccountId: number | null = null;
  private isLiveEnvironment: boolean = false;
  private symbols: CTraderSymbol[] = [...DEFAULT_SYMBOLS];
  private positions: CTraderPosition[] = [];
  private pendingOrders: CTraderPendingOrder[] = [];
  private lastError: string | null = null;
  private sandboxBalance: number = 10000.0;
  private sandboxCurrency: string = 'USD';
  private accountDetails: Map<number, { balance: number; currency: string; leverage?: number; freeMargin?: number }> = new Map();

  constructor() {
    this.loadPersistedConfig();
  }

  private loadPersistedConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const data = JSON.parse(raw);
        if (data.clientId) this.clientId = data.clientId;
        if (data.clientSecret) this.clientSecret = data.clientSecret;
        if (data.sandboxBalance !== undefined) this.sandboxBalance = Number(data.sandboxBalance);
        if (data.accessToken) {
          this.accessToken = data.accessToken;
          this.mode = 'live_api';
          // asynchronously fetch accounts once loaded
          setTimeout(() => {
            this.fetchAccountsFromCTrader().catch(() => {});
          }, 500);
        }
      }
    } catch (e) {
      console.warn('Could not read .ctrader_config.json:', e);
    }
  }

  private persistConfig() {
    try {
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(
          {
            clientId: this.clientId,
            clientSecret: this.clientSecret,
            accessToken: this.accessToken,
            sandboxBalance: this.sandboxBalance,
          },
          null,
          2
        ),
        'utf-8'
      );
    } catch (e) {
      console.warn('Could not write .ctrader_config.json:', e);
    }
  }

  public getCredentialsStatus() {
    const hasClientId = Boolean(this.clientId && this.clientId !== 'MY_CTRADER_CLIENT_ID');
    const hasClientSecret = Boolean(this.clientSecret && this.clientSecret !== 'MY_CTRADER_CLIENT_SECRET');
    const activeAccountId = this.selectedAccountId || (this.mode === 'sandbox' ? 50091824 : null);

    const accountsList: CTraderAccount[] = this.mode === 'sandbox'
      ? [
          {
            ctidTraderAccountId: 50091824,
            isLive: false,
            traderLogin: 8841209,
            brokerTitleShort: 'cTrader Demo (Sandbox)',
            balance: this.sandboxBalance,
            currency: this.sandboxCurrency,
            leverage: 100,
          },
        ]
      : this.accounts.map((acc) => {
          const det = this.accountDetails.get(acc.ctidTraderAccountId);
          return {
            ...acc,
            balance: det?.balance ?? acc.balance,
            currency: det?.currency ?? acc.currency ?? 'USD',
            leverage: det?.leverage ?? acc.leverage,
            freeMargin: det?.freeMargin ?? acc.freeMargin,
          };
        });

    const activeAcc = accountsList.find((a) => a.ctidTraderAccountId === activeAccountId) || accountsList[0];

    return {
      hasClientId,
      hasClientSecret,
      clientIdMasked: this.clientId ? (this.clientId.length > 8 ? `${this.clientId.slice(0, 4)}...${this.clientId.slice(-4)}` : this.clientId) : '',
      hasAccessToken: Boolean(this.accessToken),
      mode: this.mode,
      selectedAccountId: activeAccountId,
      isLiveEnvironment: this.isLiveEnvironment,
      accounts: accountsList,
      activeAccount: activeAcc,
      lastError: this.lastError,
    };
  }

  public setSandboxBalance(amount: number) {
    if (amount > 0) {
      this.sandboxBalance = Math.round(amount * 100) / 100;
      this.persistConfig();
    }
    return this.sandboxBalance;
  }

  public async setCredentials(params: { clientId?: string; clientSecret?: string; accessToken?: string }) {
    if (params.clientId) this.clientId = params.clientId.trim();
    if (params.clientSecret) this.clientSecret = params.clientSecret.trim();
    if (params.accessToken !== undefined) {
      this.accessToken = params.accessToken.trim();
      if (this.accessToken) {
        this.mode = 'live_api';
      }
    }
    this.persistConfig();
    this.lastError = null;

    if (this.accessToken) {
      await this.fetchAccountsFromCTrader();
    }
  }

  public async setAccessToken(token: string) {
    this.accessToken = token.trim();
    this.lastError = null;
    this.persistConfig();
    if (this.accessToken) {
      this.mode = 'live_api';
      try {
        await this.fetchAccountsFromCTrader();
      } catch (err: any) {
        console.warn('[cTrader] setAccessToken initial account fetch warning:', err.message);
        this.lastError = err.message;
      }
    } else {
      this.mode = 'sandbox';
    }
  }

  public setMode(mode: 'live_api' | 'sandbox') {
    this.mode = mode;
    this.lastError = null;
  }

  public async selectAccount(ctidTraderAccountId: number) {
    this.selectedAccountId = ctidTraderAccountId;
    const acc = this.accounts.find((a) => a.ctidTraderAccountId === ctidTraderAccountId);
    if (acc) {
      this.isLiveEnvironment = acc.isLive;
    }
    if (this.mode === 'live_api' && this.accessToken) {
      await this.reconcileAccount();
    }
  }

  // Helper to run a sequence of requests over cTrader Open API JSON WebSocket
  private async executeWithWebSocket<T>(
    isLive: boolean,
    handler: (
      sendRequest: (payloadType: number, payload: Record<string, unknown>, expectedResTypes?: number[]) => Promise<{ payloadType: number; payload: any }>
    ) => Promise<T>
  ): Promise<T> {
    const clientId = this.clientId || process.env.CTRADER_CLIENT_ID;
    const clientSecret = this.clientSecret || process.env.CTRADER_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('مقادیر Client ID و Client Secret تنظیم نشده‌اند. لطفاً از بخش تنظیمات حساب آن‌ها را وارد کنید.');
    }

    const endpoint = isLive ? 'wss://live.ctraderapi.com:5036' : 'wss://demo.ctraderapi.com:5036';
    const envLabel = isLive ? 'Live' : 'Demo';

    return new Promise<T>((resolve, reject) => {
      let isSettled = false;
      const ws = new WebSocket(endpoint);
      const pendingRequests = new Map<
        string,
        {
          resolve: (val: { payloadType: number; payload: any }) => void;
          reject: (err: Error) => void;
          expectedResTypes?: number[];
        }
      >();

      const timeout = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try { ws.close(); } catch {}
          reject(new Error(`مهلت زمانی اتصال به سرور cTrader (${envLabel}) به پایان رسید (Timeout).`));
        }
      }, 35000);

      let msgCounter = 1;

      const sendRequest = (
        payloadType: number,
        payload: Record<string, unknown>,
        expectedResTypes?: number[]
      ): Promise<{ payloadType: number; payload: any }> => {
        return new Promise((resReq, rejReq) => {
          if (isSettled) {
            rejReq(new Error('ارتباط با سرور cTrader بسته شده است.'));
            return;
          }
          const clientMsgId = `msg_${Date.now()}_${msgCounter++}`;
          pendingRequests.set(clientMsgId, { resolve: resReq, reject: rejReq, expectedResTypes });
          ws.send(
            JSON.stringify({
              clientMsgId,
              payloadType,
              payload,
            })
          );
        });
      };

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const rawText = data.toString();
          const msg = JSON.parse(rawText);
          if (msg.payloadType === PAYLOAD_TYPES.HEARTBEAT_EVENT) {
            return;
          }

          const clientMsgId = msg.clientMsgId;
          const isError =
            msg.payloadType === PAYLOAD_TYPES.OA_ERROR_RES ||
            msg.payloadType === PAYLOAD_TYPES.ORDER_ERROR_EVENT ||
            Boolean(msg.payload?.errorCode);

          if (isError) {
            const errDesc = msg.payload?.description || msg.payload?.errorCode || 'خطا از سمت سرور cTrader';
            if (clientMsgId && pendingRequests.has(clientMsgId)) {
              const req = pendingRequests.get(clientMsgId)!;
              pendingRequests.delete(clientMsgId);
              req.reject(new Error(String(errDesc)));
              return;
            }
            const firstEntry = pendingRequests.entries().next().value;
            if (firstEntry) {
              const [firstKey, req] = firstEntry;
              pendingRequests.delete(firstKey);
              req.reject(new Error(String(errDesc)));
              return;
            }
          }

          // Direct clientMsgId match
          if (clientMsgId && pendingRequests.has(clientMsgId)) {
            const req = pendingRequests.get(clientMsgId)!;
            pendingRequests.delete(clientMsgId);
            req.resolve({ payloadType: msg.payloadType, payload: msg.payload });
            return;
          }

          // Match by expectedResTypes
          for (const [key, req] of pendingRequests.entries()) {
            if (req.expectedResTypes && req.expectedResTypes.includes(msg.payloadType)) {
              pendingRequests.delete(key);
              req.resolve({ payloadType: msg.payloadType, payload: msg.payload });
              return;
            }
          }

          // Single in-flight request match
          if (pendingRequests.size === 1) {
            const onlyEntry = pendingRequests.entries().next().value;
            if (onlyEntry) {
              const [onlyKey, req] = onlyEntry;
              pendingRequests.delete(onlyKey);
              req.resolve({ payloadType: msg.payloadType, payload: msg.payload });
              return;
            }
          }
        } catch (err) {
          console.warn('[cTrader WS] Parse error:', err);
        }
      });

      ws.on('error', (err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeout);
          reject(new Error(`خطای ارتباط WebSocket با cTrader (${envLabel}): ${err.message}`));
        }
      });

      ws.on('close', (code) => {
        if (!isSettled && pendingRequests.size > 0) {
          for (const [key, req] of pendingRequests.entries()) {
            pendingRequests.delete(key);
            req.reject(new Error(`ارتباط با سرور cTrader قطع شد (کد ${code}).`));
          }
        }
      });

      ws.on('open', async () => {
        try {
          // Step 1: Authenticate Application (2100 -> 2101)
          await sendRequest(
            PAYLOAD_TYPES.APPLICATION_AUTH_REQ,
            {
              clientId,
              clientSecret,
            },
            [PAYLOAD_TYPES.APPLICATION_AUTH_RES, PAYLOAD_TYPES.OA_ERROR_RES]
          );

          const result = await handler(sendRequest);
          if (!isSettled) {
            isSettled = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            resolve(result);
          }
        } catch (err: any) {
          if (!isSettled) {
            isSettled = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            reject(err);
          }
        }
      });
    });
  }

  public async fetchAccountsFromCTrader(): Promise<CTraderAccount[]> {
    if (!this.accessToken) {
      throw new Error('توکن دسترسی (Access Token) وارد نشده است.');
    }

    let accounts: CTraderAccount[] = [];
    let lastError: Error | null = null;

    // 1. Try Live endpoint
    try {
      accounts = await this.executeWithWebSocket(true, async (sendRequest) => {
        const res = await sendRequest(
          PAYLOAD_TYPES.GET_ACCOUNTS_BY_TOKEN_REQ,
          { accessToken: this.accessToken },
          [PAYLOAD_TYPES.GET_ACCOUNTS_BY_TOKEN_RES, PAYLOAD_TYPES.OA_ERROR_RES]
        );
        const list = res.payload?.ctidTraderAccount || [];
        return list.map((acc: any) => ({
          ctidTraderAccountId: Number(acc.ctidTraderAccountId),
          isLive: Boolean(acc.isLive),
          traderLogin: Number(acc.traderLogin || acc.ctidTraderAccountId),
          brokerTitleShort: acc.brokerTitleShort || (acc.isLive ? 'cTrader Live' : 'cTrader Demo'),
        }));
      });
    } catch (err: any) {
      console.warn('[cTrader] Live endpoint account query error:', err.message);
      lastError = err;
    }

    // 2. If no accounts on Live or error, try Demo endpoint
    if (accounts.length === 0) {
      try {
        accounts = await this.executeWithWebSocket(false, async (sendRequest) => {
          const res = await sendRequest(
            PAYLOAD_TYPES.GET_ACCOUNTS_BY_TOKEN_REQ,
            { accessToken: this.accessToken },
            [PAYLOAD_TYPES.GET_ACCOUNTS_BY_TOKEN_RES, PAYLOAD_TYPES.OA_ERROR_RES]
          );
          const list = res.payload?.ctidTraderAccount || [];
          return list.map((acc: any) => ({
            ctidTraderAccountId: Number(acc.ctidTraderAccountId),
            isLive: Boolean(acc.isLive),
            traderLogin: Number(acc.traderLogin || acc.ctidTraderAccountId),
            brokerTitleShort: acc.brokerTitleShort || (acc.isLive ? 'cTrader Live' : 'cTrader Demo'),
          }));
        });
      } catch (err: any) {
        console.warn('[cTrader] Demo endpoint account query error:', err.message);
        if (!lastError) lastError = err;
      }
    }

    if (accounts.length > 0) {
      this.accounts = accounts;
      if (!this.selectedAccountId || !accounts.some((a) => a.ctidTraderAccountId === this.selectedAccountId)) {
        this.selectedAccountId = accounts[0].ctidTraderAccountId;
        this.isLiveEnvironment = accounts[0].isLive;
      } else {
        const cur = accounts.find((a) => a.ctidTraderAccountId === this.selectedAccountId);
        if (cur) this.isLiveEnvironment = cur.isLive;
      }
      this.lastError = null;

      // Start reconcile asynchronously in background so we never block callers
      this.reconcileAccount().catch((e) => {
        console.warn('[cTrader] Background reconcile after account fetch:', e.message);
      });
    } else if (lastError) {
      this.lastError = lastError.message;
      console.warn('[cTrader] Account list not retrieved:', lastError.message);
    }

    return this.accounts;
  }

  public async reconcileAccount() {
    if (this.mode === 'sandbox') {
      return {
        symbols: this.symbols,
        positions: this.positions,
        pendingOrders: this.pendingOrders,
      };
    }

    if (!this.selectedAccountId || !this.accessToken) {
      throw new Error('اکانت معاملاتی یا توکن دسترسی انتخاب نشده است.');
    }

    const accountId = this.selectedAccountId;
    try {
      await this.executeWithWebSocket(this.isLiveEnvironment, async (sendRequest) => {
        // Authorize trading account (2102 -> 2103)
        await sendRequest(PAYLOAD_TYPES.ACCOUNT_AUTH_REQ, {
          ctidTraderAccountId: accountId,
          accessToken: this.accessToken,
        });

        // Query trader account profile & balance (2121 -> 2122)
        try {
          const traderRes = await sendRequest(
            PAYLOAD_TYPES.TRADER_REQ,
            { ctidTraderAccountId: accountId },
            [PAYLOAD_TYPES.TRADER_RES, PAYLOAD_TYPES.OA_ERROR_RES]
          );
          const t = traderRes.payload?.trader;
          if (t) {
            const digits = t.moneyDigits !== undefined ? Number(t.moneyDigits) : 2;
            const balance = t.balance !== undefined ? Number(t.balance) / Math.pow(10, digits) : 0;
            const leverage = t.leverageInCents ? Number(t.leverageInCents) / 100 : undefined;
            const depositAssetId = t.depositAssetId ? String(t.depositAssetId) : 'USD';
            this.accountDetails.set(accountId, {
              balance,
              currency: depositAssetId,
              leverage,
            });
            const acc = this.accounts.find((a) => a.ctidTraderAccountId === accountId);
            if (acc) {
              acc.balance = balance;
              acc.currency = depositAssetId;
              acc.leverage = leverage;
            }
          }
        } catch (traderErr: any) {
          console.warn('[cTrader] TRADER_REQ warning:', traderErr.message);
        }

        // Get light symbols list (2114 -> 2115)
        const symRes = await sendRequest(PAYLOAD_TYPES.SYMBOLS_LIST_REQ, {
          ctidTraderAccountId: accountId,
        });

        // Reconcile open positions and pending orders (2124 -> 2125)
        const recRes = await sendRequest(PAYLOAD_TYPES.RECONCILE_REQ, {
          ctidTraderAccountId: accountId,
        });

        const rawPositions = recRes.payload?.position || [];
        const rawOrders = recRes.payload?.order || [];

        const activeSymbolIds = new Set<number>();
        for (const p of rawPositions) {
          const sid = Number(p.tradeData?.symbolId || p.symbolId);
          if (sid) activeSymbolIds.add(sid);
        }
        for (const o of rawOrders) {
          const sid = Number(o.tradeData?.symbolId || o.symbolId);
          if (sid) activeSymbolIds.add(sid);
        }

        const rawSymbols = (symRes.payload?.symbol || []).filter((s: any) => s.enabled !== false);
        if (rawSymbols.length > 0) {
          // Sort so popular symbols and active position symbols appear first
          rawSymbols.sort((a: any, b: any) => {
            const aActive = activeSymbolIds.has(Number(a.symbolId)) ? 0 : 1;
            const bActive = activeSymbolIds.has(Number(b.symbolId)) ? 0 : 1;
            if (aActive !== bActive) return aActive - bActive;

            const aName = String(a.symbolName || '').toUpperCase();
            const bName = String(b.symbolName || '').toUpperCase();
            const aIdx = PRIORITY_SYMBOLS.findIndex((p) => aName === p || aName.startsWith(p));
            const bIdx = PRIORITY_SYMBOLS.findIndex((p) => bName === p || bName.startsWith(p));
            const aScore = aIdx === -1 ? 999 : aIdx;
            const bScore = bIdx === -1 ? 999 : bIdx;
            if (aScore !== bScore) return aScore - bScore;
            return aName.localeCompare(bName);
          });

          const selectedLightSymbols = rawSymbols.slice(0, 80);
          const idsToDetail = selectedLightSymbols.slice(0, 35).map((s: any) => Number(s.symbolId));

          const detailMap = new Map<number, any>();
          if (idsToDetail.length > 0) {
            try {
              const detailRes = await sendRequest(PAYLOAD_TYPES.SYMBOL_BY_ID_REQ, {
                ctidTraderAccountId: accountId,
                symbolId: idsToDetail,
              });
              for (const fullSym of detailRes.payload?.symbol || []) {
                detailMap.set(Number(fullSym.symbolId), fullSym);
              }
            } catch {
              // Ignore if symbol detail lookup fails and use smart fallback
            }
          }

          this.symbols = selectedLightSymbols.map((s: any) => {
            const sid = Number(s.symbolId);
            const name = String(s.symbolName || `SYM_${sid}`);
            const full = detailMap.get(sid);
            const fallback = DEFAULT_SYMBOLS.find((d) => name.toUpperCase().startsWith(d.symbolName));
            const defaultLot = fallback?.lotSize ?? inferDefaultLotSize(name);
            const lotSize = full?.lotSize ? Number(full.lotSize) : defaultLot;
            const stepVolume = full?.stepVolume ? Number(full.stepVolume) : Math.max(1, Math.round(lotSize / 100));
            const minVolume = full?.minVolume ? Number(full.minVolume) : stepVolume;
            return {
              symbolId: sid,
              symbolName: name,
              digits: full?.digits !== undefined ? Number(full.digits) : (fallback?.digits ?? 5),
              pipPosition: full?.pipPosition !== undefined ? Number(full.pipPosition) : (fallback?.pipPosition ?? 4),
              lotSize,
              minVolume,
              stepVolume,
              description: String(s.description || fallback?.description || name),
              referencePrice: fallback?.referencePrice ?? 1.0,
            };
          });
        }

        const symbolObjMap = new Map<number, CTraderSymbol>();
        for (const s of this.symbols) {
          symbolObjMap.set(s.symbolId, s);
        }

        this.positions = rawPositions.map((p: any) => {
          const symId = Number(p.tradeData?.symbolId || p.symbolId);
          const symObj = symbolObjMap.get(symId);
          const volProto = Number(p.tradeData?.volume || 0);
          const side = p.tradeData?.tradeSide === 2 || p.tradeData?.tradeSide === 'SELL' ? 'SELL' : 'BUY';
          const volLots = protocolVolumeToLots(volProto, symObj);
          const entryPrice = Number(p.price || 0);
          const commission = Number(p.commission || 0) / 100;
          const swap = Number(p.swap || 0) / 100;
          const pnl = computePositionPnL(
            {
              symbolId: symId,
              symbolName: symObj?.symbolName,
              tradeSide: side,
              volumeLots: volLots,
              entryPrice,
              commission,
              swap,
            },
            symObj
          );

          return {
            positionId: Number(p.positionId),
            symbolId: symId,
            symbolName: symObj?.symbolName || `SYM#${symId}`,
            tradeSide: side,
            volumeLots: volLots,
            volumeProtocol: volProto,
            entryPrice,
            currentPrice: pnl.currentPrice,
            grossProfit: pnl.grossProfit,
            netProfit: pnl.netProfit,
            pips: pnl.pips,
            stopLoss: p.stopLoss ? Number(p.stopLoss) : null,
            takeProfit: p.takeProfit ? Number(p.takeProfit) : null,
            swap,
            commission,
            comment: String(p.tradeData?.comment || ''),
            openTimestamp: Number(p.tradeData?.openTimestamp || Date.now()),
          };
        });

        this.pendingOrders = rawOrders
          .filter((o: any) => o.orderType !== 'MARKET' && o.orderType !== 1 && o.orderStatus !== 'ORDER_STATUS_FILLED')
          .map((o: any) => {
            const symId = Number(o.tradeData?.symbolId || o.symbolId);
            const symObj = symbolObjMap.get(symId);
            const volProto = Number(o.tradeData?.volume || 0);
            const side = o.tradeData?.tradeSide === 2 || o.tradeData?.tradeSide === 'SELL' ? 'SELL' : 'BUY';
            const oType = o.orderType === 3 || o.orderType === 'STOP' ? 'STOP' : 'LIMIT';
            return {
              orderId: Number(o.orderId),
              symbolId: symId,
              symbolName: symObj?.symbolName || `SYM#${symId}`,
              orderType: oType,
              tradeSide: side,
              volumeLots: protocolVolumeToLots(volProto, symObj),
              volumeProtocol: volProto,
              limitPrice: o.limitPrice ? Number(o.limitPrice) : null,
              stopPrice: o.stopPrice ? Number(o.stopPrice) : null,
              stopLoss: o.stopLoss ? Number(o.stopLoss) : null,
              takeProfit: o.takeProfit ? Number(o.takeProfit) : null,
              comment: String(o.tradeData?.comment || ''),
              openTimestamp: Number(o.tradeData?.openTimestamp || Date.now()),
            };
          });
      });

      this.lastError = null;
      return this.getStateSnapshot();
    } catch (err: any) {
      this.lastError = err.message;
      throw err;
    }
  }

  public updateSymbolPrice(symbolId: number, price: number): boolean {
    const sym = this.symbols.find((s) => s.symbolId === symbolId);
    if (sym && price > 0) {
      sym.referencePrice = price;
      return true;
    }
    return false;
  }

  public getStateSnapshot() {
    const symbolMap = new Map<number, CTraderSymbol>();
    for (const s of this.symbols) {
      symbolMap.set(s.symbolId, s);
    }

    const enrichedPositions: CTraderPosition[] = this.positions.map((p) => {
      const sym = symbolMap.get(p.symbolId);
      const pnl = computePositionPnL(p, sym);
      return {
        ...p,
        currentPrice: pnl.currentPrice,
        grossProfit: pnl.grossProfit,
        netProfit: pnl.netProfit,
        pips: pnl.pips,
      };
    });

    return {
      status: this.getCredentialsStatus(),
      symbols: this.symbols,
      positions: enrichedPositions,
      pendingOrders: this.pendingOrders,
    };
  }

  // Create New Order (ProtoOANewOrderReq - payloadType 2106)
  public async placeNewOrder(params: {
    symbolId: number;
    orderType: 'MARKET' | 'LIMIT' | 'STOP';
    tradeSide: 'BUY' | 'SELL';
    volumeLots: number;
    limitPrice?: number | null;
    stopPrice?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
    comment?: string;
  }) {
    let symbol = this.symbols.find((s) => s.symbolId === Number(params.symbolId)) || DEFAULT_SYMBOLS[0];
    let volumeProtocol = lotsToProtocolVolume(params.volumeLots, symbol);

    if (this.mode === 'sandbox') {
      if (params.orderType === 'MARKET') {
        const commission = Number((-7 * params.volumeLots).toFixed(2));
        const pnl = computePositionPnL(
          {
            symbolId: symbol.symbolId,
            symbolName: symbol.symbolName,
            tradeSide: params.tradeSide,
            volumeLots: Number(params.volumeLots),
            entryPrice: symbol.referencePrice,
            commission,
            swap: 0,
          },
          symbol
        );

        const newPos: CTraderPosition = {
          positionId: Math.floor(78500000 + Math.random() * 900000),
          symbolId: symbol.symbolId,
          symbolName: symbol.symbolName,
          tradeSide: params.tradeSide,
          volumeLots: Number(params.volumeLots),
          volumeProtocol,
          entryPrice: symbol.referencePrice,
          currentPrice: pnl.currentPrice,
          grossProfit: pnl.grossProfit,
          netProfit: pnl.netProfit,
          pips: pnl.pips,
          stopLoss: params.stopLoss ? Number(params.stopLoss) : null,
          takeProfit: params.takeProfit ? Number(params.takeProfit) : null,
          swap: 0,
          commission,
          comment: params.comment || '',
          openTimestamp: Date.now(),
        };
        this.positions.unshift(newPos);
        return { type: 'POSITION_OPENED', item: newPos };
      } else {
        const newOrd: CTraderPendingOrder = {
          orderId: Math.floor(99200000 + Math.random() * 900000),
          symbolId: symbol.symbolId,
          symbolName: symbol.symbolName,
          orderType: params.orderType,
          tradeSide: params.tradeSide,
          volumeLots: Number(params.volumeLots),
          volumeProtocol,
          limitPrice: params.orderType === 'LIMIT' && params.limitPrice ? Number(params.limitPrice) : null,
          stopPrice: params.orderType === 'STOP' && params.stopPrice ? Number(params.stopPrice) : null,
          stopLoss: params.stopLoss ? Number(params.stopLoss) : null,
          takeProfit: params.takeProfit ? Number(params.takeProfit) : null,
          comment: params.comment || '',
          openTimestamp: Date.now(),
        };
        this.pendingOrders.unshift(newOrd);
        return { type: 'ORDER_PLACED', item: newOrd };
      }
    }

    // Live / Demo cTrader Open API WebSocket execution
    if (!this.selectedAccountId || !this.accessToken) {
      throw new Error('ابتدا به اکانت cTrader متصل شوید.');
    }

    const accountId = this.selectedAccountId;
    await this.executeWithWebSocket(this.isLiveEnvironment, async (sendRequest) => {
      await sendRequest(PAYLOAD_TYPES.ACCOUNT_AUTH_REQ, {
        ctidTraderAccountId: accountId,
        accessToken: this.accessToken,
      });

      // Query exact symbol specification (2116 -> 2117) to ensure exact broker lotSize & stepVolume
      try {
        const symDetailRes = await sendRequest(PAYLOAD_TYPES.SYMBOL_BY_ID_REQ, {
          ctidTraderAccountId: accountId,
          symbolId: [Number(params.symbolId)],
        });
        const fullSym = symDetailRes.payload?.symbol?.[0];
        if (fullSym && fullSym.lotSize) {
          symbol = {
            ...symbol,
            lotSize: Number(fullSym.lotSize),
            minVolume: Number(fullSym.minVolume || fullSym.stepVolume || 100),
            stepVolume: Number(fullSym.stepVolume || 100),
            digits: fullSym.digits !== undefined ? Number(fullSym.digits) : symbol.digits,
            pipPosition: fullSym.pipPosition !== undefined ? Number(fullSym.pipPosition) : symbol.pipPosition,
          };
          volumeProtocol = lotsToProtocolVolume(params.volumeLots, symbol);
        }
      } catch {
        // Fallback to cached symbol specification
      }

      const orderPayload: Record<string, unknown> = {
        ctidTraderAccountId: accountId,
        symbolId: Number(params.symbolId),
        orderType: params.orderType,
        tradeSide: params.tradeSide,
        volume: volumeProtocol,
      };

      if (params.comment) {
        orderPayload.comment = params.comment;
      }

      if (params.orderType === 'LIMIT' && params.limitPrice) {
        orderPayload.limitPrice = Number(params.limitPrice);
      }
      if (params.orderType === 'STOP' && params.stopPrice) {
        orderPayload.stopPrice = Number(params.stopPrice);
      }

      // For pending orders, absolute stopLoss and takeProfit can be passed directly
      if (params.orderType !== 'MARKET') {
        if (params.stopLoss) orderPayload.stopLoss = Number(params.stopLoss);
        if (params.takeProfit) orderPayload.takeProfit = Number(params.takeProfit);
      }

      const execRes = await sendRequest(
        PAYLOAD_TYPES.NEW_ORDER_REQ,
        orderPayload,
        [PAYLOAD_TYPES.EXECUTION_EVENT, PAYLOAD_TYPES.ORDER_ERROR_EVENT]
      );

      // If Market order has absolute SL/TP, amend position SL/TP immediately after fill
      if (params.orderType === 'MARKET' && (params.stopLoss || params.takeProfit)) {
        let createdPositionId = execRes.payload?.position?.positionId || execRes.payload?.order?.positionId;
        if (!createdPositionId) {
          const recRes = await sendRequest(PAYLOAD_TYPES.RECONCILE_REQ, {
            ctidTraderAccountId: accountId,
          });
          const positions = recRes.payload?.position || [];
          const matching = positions
            .filter((p: any) => Number(p.tradeData?.symbolId || p.symbolId) === Number(params.symbolId))
            .sort((a: any, b: any) => Number(b.positionId) - Number(a.positionId));
          if (matching.length > 0) {
            createdPositionId = matching[0].positionId;
          }
        }

        if (createdPositionId) {
          const sltpPayload: Record<string, unknown> = {
            ctidTraderAccountId: accountId,
            positionId: Number(createdPositionId),
          };
          if (params.stopLoss) sltpPayload.stopLoss = Number(params.stopLoss);
          if (params.takeProfit) sltpPayload.takeProfit = Number(params.takeProfit);

          await sendRequest(
            PAYLOAD_TYPES.AMEND_POSITION_SLTP_REQ,
            sltpPayload,
            [PAYLOAD_TYPES.EXECUTION_EVENT, PAYLOAD_TYPES.ORDER_ERROR_EVENT]
          );
        }
      }
    });

    await this.reconcileAccount();
    return { type: 'LIVE_ORDER_EXECUTED' };
  }

  // Amend Open Position SL/TP (ProtoOAAmendPositionSLTPReq - payloadType 2110)
  public async amendPosition(params: {
    positionId: number;
    stopLoss: number | null;
    takeProfit: number | null;
  }) {
    if (this.mode === 'sandbox') {
      const pos = this.positions.find((p) => p.positionId === Number(params.positionId));
      if (!pos) {
        throw new Error(`پوزیشن با شناسه ${params.positionId} یافت نشد.`);
      }
      pos.stopLoss = params.stopLoss ? Number(params.stopLoss) : null;
      pos.takeProfit = params.takeProfit ? Number(params.takeProfit) : null;
      return { type: 'POSITION_AMENDED', item: pos };
    }

    if (!this.selectedAccountId || !this.accessToken) {
      throw new Error('ابتدا به اکانت cTrader متصل شوید.');
    }

    const accountId = this.selectedAccountId;
    await this.executeWithWebSocket(this.isLiveEnvironment, async (sendRequest) => {
      await sendRequest(PAYLOAD_TYPES.ACCOUNT_AUTH_REQ, {
        ctidTraderAccountId: accountId,
        accessToken: this.accessToken,
      });

      const payload: Record<string, unknown> = {
        ctidTraderAccountId: accountId,
        positionId: Number(params.positionId),
      };
      if (params.stopLoss !== null && params.stopLoss !== undefined && Number(params.stopLoss) > 0) {
        payload.stopLoss = Number(params.stopLoss);
      }
      if (params.takeProfit !== null && params.takeProfit !== undefined && Number(params.takeProfit) > 0) {
        payload.takeProfit = Number(params.takeProfit);
      }

      await sendRequest(
        PAYLOAD_TYPES.AMEND_POSITION_SLTP_REQ,
        payload,
        [PAYLOAD_TYPES.EXECUTION_EVENT, PAYLOAD_TYPES.ORDER_ERROR_EVENT]
      );
    });

    await this.reconcileAccount();
    return { type: 'LIVE_POSITION_AMENDED' };
  }

  // Amend Pending Order (ProtoOAAmendOrderReq - payloadType 2109)
  public async amendPendingOrder(params: {
    orderId: number;
    volumeLots: number;
    limitPrice?: number | null;
    stopPrice?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
  }) {
    const existingOrd = this.pendingOrders.find((o) => o.orderId === Number(params.orderId));
    const symbol = existingOrd
      ? this.symbols.find((s) => s.symbolId === existingOrd.symbolId)
      : undefined;
    const volumeProtocol = lotsToProtocolVolume(params.volumeLots, symbol);

    if (this.mode === 'sandbox') {
      if (!existingOrd) {
        throw new Error(`سفارش در انتظار با شناسه ${params.orderId} یافت نشد.`);
      }
      existingOrd.volumeLots = Number(params.volumeLots);
      existingOrd.volumeProtocol = volumeProtocol;
      if (existingOrd.orderType === 'LIMIT' && params.limitPrice) {
        existingOrd.limitPrice = Number(params.limitPrice);
      }
      if (existingOrd.orderType === 'STOP' && params.stopPrice) {
        existingOrd.stopPrice = Number(params.stopPrice);
      }
      existingOrd.stopLoss = params.stopLoss ? Number(params.stopLoss) : null;
      existingOrd.takeProfit = params.takeProfit ? Number(params.takeProfit) : null;
      return { type: 'ORDER_AMENDED', item: existingOrd };
    }

    if (!this.selectedAccountId || !this.accessToken) {
      throw new Error('ابتدا به اکانت cTrader متصل شوید.');
    }

    const accountId = this.selectedAccountId;
    await this.executeWithWebSocket(this.isLiveEnvironment, async (sendRequest) => {
      await sendRequest(PAYLOAD_TYPES.ACCOUNT_AUTH_REQ, {
        ctidTraderAccountId: accountId,
        accessToken: this.accessToken,
      });

      const payload: Record<string, unknown> = {
        ctidTraderAccountId: accountId,
        orderId: Number(params.orderId),
        volume: volumeProtocol,
      };
      if (params.limitPrice) payload.limitPrice = Number(params.limitPrice);
      if (params.stopPrice) payload.stopPrice = Number(params.stopPrice);
      if (params.stopLoss) payload.stopLoss = Number(params.stopLoss);
      if (params.takeProfit) payload.takeProfit = Number(params.takeProfit);

      await sendRequest(
        PAYLOAD_TYPES.AMEND_ORDER_REQ,
        payload,
        [PAYLOAD_TYPES.EXECUTION_EVENT, PAYLOAD_TYPES.ORDER_ERROR_EVENT]
      );
    });

    await this.reconcileAccount();
    return { type: 'LIVE_ORDER_AMENDED' };
  }

  // Close Open Position (ProtoOAClosePositionReq - payloadType 2111)
  public async closePosition(positionId: number, volumeLots?: number) {
    if (this.mode === 'sandbox') {
      const idx = this.positions.findIndex((p) => p.positionId === Number(positionId));
      if (idx === -1) throw new Error('پوزیشن مورد نظر یافت نشد.');
      const removed = this.positions.splice(idx, 1)[0];
      const sym = this.symbols.find((s) => s.symbolId === removed.symbolId);
      const pnl = computePositionPnL(removed, sym);
      const profit = pnl.netProfit;
      this.sandboxBalance = Math.max(0, Number((this.sandboxBalance + (isNaN(profit) ? 0 : profit)).toFixed(2)));
      this.persistConfig();
      return { type: 'POSITION_CLOSED', item: removed, profit, balance: this.sandboxBalance };
    }

    if (!this.selectedAccountId || !this.accessToken) {
      throw new Error('ابتدا به اکانت cTrader متصل شوید.');
    }

    const pos = this.positions.find((p) => p.positionId === Number(positionId));
    const volumeProtocol = volumeLots
      ? lotsToProtocolVolume(volumeLots)
      : pos?.volumeProtocol || lotsToProtocolVolume(0.01);

    const accountId = this.selectedAccountId;
    await this.executeWithWebSocket(this.isLiveEnvironment, async (sendRequest) => {
      await sendRequest(PAYLOAD_TYPES.ACCOUNT_AUTH_REQ, {
        ctidTraderAccountId: accountId,
        accessToken: this.accessToken,
      });

      await sendRequest(
        PAYLOAD_TYPES.CLOSE_POSITION_REQ,
        {
          ctidTraderAccountId: accountId,
          positionId: Number(positionId),
          volume: volumeProtocol,
        },
        [PAYLOAD_TYPES.EXECUTION_EVENT, PAYLOAD_TYPES.ORDER_ERROR_EVENT]
      );
    });

    await this.reconcileAccount();
    return { type: 'LIVE_POSITION_CLOSED' };
  }

  // Cancel Pending Order (ProtoOACancelOrderReq - payloadType 2108)
  public async cancelOrder(orderId: number) {
    if (this.mode === 'sandbox') {
      const idx = this.pendingOrders.findIndex((o) => o.orderId === Number(orderId));
      if (idx === -1) throw new Error('سفارش مورد نظر یافت نشد.');
      const removed = this.pendingOrders.splice(idx, 1)[0];
      return { type: 'ORDER_CANCELLED', item: removed };
    }

    if (!this.selectedAccountId || !this.accessToken) {
      throw new Error('ابتدا به اکانت cTrader متصل شوید.');
    }

    const accountId = this.selectedAccountId;
    await this.executeWithWebSocket(this.isLiveEnvironment, async (sendRequest) => {
      await sendRequest(PAYLOAD_TYPES.ACCOUNT_AUTH_REQ, {
        ctidTraderAccountId: accountId,
        accessToken: this.accessToken,
      });

      await sendRequest(
        PAYLOAD_TYPES.CANCEL_ORDER_REQ,
        {
          ctidTraderAccountId: accountId,
          orderId: Number(orderId),
        },
        [PAYLOAD_TYPES.EXECUTION_EVENT, PAYLOAD_TYPES.ORDER_ERROR_EVENT]
      );
    });

    await this.reconcileAccount();
    return { type: 'LIVE_ORDER_CANCELLED' };
  }
}

const ctraderManager = new CTraderManager();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // --- Secure Environment Variable Authentication ---
  const validAuthTokens = new Map<string, { username: string; expiresAt: number }>();

  function generateAuthToken(username: string): string {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days validity
    validAuthTokens.set(token, { username, expiresAt });
    return token;
  }

  function verifyAuthToken(token?: string): { valid: boolean; username?: string } {
    if (!token) return { valid: false };
    const session = validAuthTokens.get(token);
    if (!session) return { valid: false };
    if (Date.now() > session.expiresAt) {
      validAuthTokens.delete(token);
      return { valid: false };
    }
    return { valid: true, username: session.username };
  }

  const requireAuth: express.RequestHandler = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : ((req.headers['x-auth-token'] as string) || (req.query.auth_token as string));

    const check = verifyAuthToken(token);
    if (!check.valid) {
      res.status(401).json({
        error: 'ابتدا وارد حساب کاربری شوید.',
        code: 'UNAUTHORIZED',
      });
      return;
    }
    (req as any).user = { username: check.username };
    next();
  };

  // Auth Endpoints (Public)
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const expectedUsername = (process.env.AUTH_USERNAME || 'admin').trim();
    const expectedPassword = process.env.AUTH_PASSWORD || 'admin123';

    if (!username || !password) {
      res.status(400).json({ error: 'نام کاربری و رمز عبور الزامی است.' });
      return;
    }

    const trimmedUser = String(username).trim();
    const inputPass = String(password);

    if (trimmedUser === expectedUsername && inputPass === expectedPassword) {
      const token = generateAuthToken(trimmedUser);
      res.json({
        success: true,
        token,
        user: { username: trimmedUser },
      });
    } else {
      res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
    }
  });

  app.get('/api/auth/me', (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : (req.headers['x-auth-token'] as string);

    const check = verifyAuthToken(token);
    if (check.valid) {
      res.json({ authenticated: true, user: { username: check.username } });
    } else {
      res.json({ authenticated: false });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : (req.headers['x-auth-token'] as string);

    if (token) {
      validAuthTokens.delete(token);
    }
    res.json({ success: true });
  });

  // Protect all /api/ctrader routes with authentication
  app.use('/api/ctrader', requireAuth);

  // 1. OAuth Authorization URL endpoint (protected)
  app.get('/api/auth/url', requireAuth, (req, res) => {
    const creds = ctraderManager.getCredentialsStatus();
    const clientId = (ctraderManager as any).clientId || process.env.CTRADER_CLIENT_ID;
    if (!clientId) {
      res.status(400).json({
        error: 'مقدار Client ID در تنظیمات برنامه یا متغیرهای محیطی تعریف نشده است. لطفاً در بخش تنظیمات حساب آن را وارد کنید.',
      });
      return;
    }

    const forwardedProto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
    const forwardedHost = req.get('x-forwarded-host') || req.get('host') || 'localhost:3000';
    const baseAppUrl = (process.env.APP_URL || `${forwardedProto}://${forwardedHost}`).replace(/\/$/, '');
    const redirectUri = (req.query.redirect_uri as string) || `${baseAppUrl}/auth/callback`;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'trading',
      product: 'web',
    });

    const authUrl = `https://openapi.ctrader.com/apps/auth?${params.toString()}`;
    res.json({ url: authUrl, redirectUri });
  });

  // Save Credentials (Client ID, Secret, and optional Access Token) directly from UI
  app.post('/api/ctrader/credentials', async (req, res) => {
    try {
      const { clientId, clientSecret, accessToken } = req.body;
      await ctraderManager.setCredentials({ clientId, clientSecret, accessToken });
      res.json(ctraderManager.getStateSnapshot());
    } catch (err: any) {
      res.status(400).json({ error: err.message, state: ctraderManager.getStateSnapshot() });
    }
  });

// Helper to exchange OAuth authorization code for Access Token using native IPv4 HTTPS
function requestCTraderToken(tokenUrl: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(tokenUrl);
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        family: 4, // Force IPv4 to avoid Docker / VPS IPv6 unreachable errors
        headers: {
          Accept: 'application/json',
          'User-Agent': 'cTrader-TradingDesk/1.0',
        },
        timeout: 18000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsedData = JSON.parse(data);
            resolve(parsedData);
          } catch {
            reject(new Error(`پاسخ دریافتی از cTrader در قالب JSON نبود: ${data.slice(0, 120)}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('مهلت زمانی اتصال به openapi.ctrader.com به پایان رسید (Timeout).'));
    });

    req.on('error', (err: any) => {
      const detail = err.code || err.message;
      reject(new Error(`خطای ارتباط با سرور cTrader (${detail})`));
    });

    req.end();
  });
}

// 2. OAuth Callback Handler (Popup postMessage flow with IPv4 & Interactive Fallback)
  app.get(['/auth/callback', '/auth/callback/'], async (req, res) => {
    const code = req.query.code as string | undefined;
    const errorDesc = req.query.error_description || req.query.error;

    if (errorDesc || !code) {
      res.send(`
        <!doctype html>
        <html lang="fa" dir="rtl">
          <head><meta charset="utf-8"><title>خطا در احراز هویت cTrader</title></head>
          <body style="font-family: system-ui, sans-serif; background: #020617; color: #f8fafc; padding: 2.5rem 1.5rem; text-align: center;">
            <div style="max-width: 440px; margin: 0 auto; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 2rem;">
              <h3 style="color: #f87171; margin: 0 0 0.5rem; font-size: 1.15rem;">خطا در اتصال به cTrader</h3>
              <p style="color: #94a3b8; font-size: 0.85rem; margin: 0 0 1.5rem;">${errorDesc || 'کد احراز هویت از سرور cTrader دریافت نشد.'}</p>
              <button onclick="window.close()" style="background: #334155; color: #fff; border: none; padding: 0.5rem 1.25rem; border-radius: 6px; font-size: 0.85rem; cursor: pointer;">بستن پنجره</button>
            </div>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: ${JSON.stringify(errorDesc || 'No code')} }, '*');
              }
            </script>
          </body>
        </html>
      `);
      return;
    }

    const clientId = (ctraderManager as any).clientId || process.env.CTRADER_CLIENT_ID || '';
    const clientSecret = (ctraderManager as any).clientSecret || process.env.CTRADER_CLIENT_SECRET || '';
    const forwardedProto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
    const forwardedHost = req.get('x-forwarded-host') || req.get('host') || 'localhost:3000';
    const baseAppUrl = (process.env.APP_URL || `${forwardedProto}://${forwardedHost}`).replace(/\/$/, '');
    const redirectUri = `${baseAppUrl}/auth/callback`;

    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const tokenUrl = `https://openapi.ctrader.com/apps/token?${tokenParams.toString()}`;

    try {
      let tokenData: any = null;

      // Try Strategy 1: IPv4 Native HTTPS request
      try {
        tokenData = await requestCTraderToken(tokenUrl);
      } catch (e1: any) {
        console.warn('[cTrader] IPv4 https.request failed, trying fetch fallback:', e1.message);
        // Try Strategy 2: Fetch fallback
        const fetchRes = await fetch(tokenUrl, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(12000),
        });
        tokenData = await fetchRes.json();
      }

      const accessToken = tokenData?.accessToken || tokenData?.access_token;

      if (!accessToken) {
        throw new Error(tokenData?.description || tokenData?.error_description || tokenData?.errorCode || 'توکن دسترسی از cTrader دریافت نشد.');
      }

      // Persist access token immediately
      await ctraderManager.setAccessToken(accessToken);

      res.send(`
        <!doctype html>
        <html lang="fa" dir="rtl">
          <head>
            <meta charset="utf-8">
            <title>اتصال موفق به cTrader</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
          </head>
          <body style="font-family: system-ui, sans-serif; background: #020617; color: #f8fafc; padding: 2.5rem 1.5rem; text-align: center;">
            <div style="max-width: 440px; margin: 0 auto; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 2rem;">
              <h3 style="margin: 0 0 0.5rem; color: #34d399; font-size: 1.15rem;">اتصال به cTrader با موفقیت انجام شد</h3>
              <p style="color: #94a3b8; font-size: 0.85rem; margin: 0 0 1.5rem;">توکن پروداکشن دریافت و در سرور ذخیره شد. پنجره در حال بسته شدن است...</p>
              <button onclick="closeNow()" style="background: #2563eb; color: #fff; border: none; padding: 0.5rem 1.25rem; border-radius: 6px; font-size: 0.85rem; cursor: pointer;">بستن پنجره</button>
            </div>
            <script>
              function closeNow() {
                try {
                  if (window.opener) {
                    window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
                    window.close();
                  } else {
                    window.location.href = '/';
                  }
                } catch {
                  window.location.href = '/';
                }
              }
              closeNow();
              setTimeout(closeNow, 800);
            </script>
          </body>
        </html>
      `);
    } catch (err: any) {
      console.error('[cTrader OAuth Error]', err);
      // Interactive Fallback UI: If server network cannot reach openapi.ctrader.com, user can fetch or paste in browser!
      res.send(`
        <!doctype html>
        <html lang="fa" dir="rtl">
          <head>
            <meta charset="utf-8">
            <title>خطا در اتصال به سرور cTrader</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
          </head>
          <body style="font-family: system-ui, sans-serif; background: #020617; color: #f8fafc; padding: 2rem 1rem; text-align: center;">
            <div style="max-width: 480px; margin: 0 auto; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 1.75rem; text-align: right;">
              <h3 style="color: #f87171; margin: 0 0 0.5rem; font-size: 1.05rem; text-align: center;">عدم دسترسی سرور به سرور cTrader</h3>
              <p style="color: #94a3b8; font-size: 0.8rem; margin: 0 0 1rem; line-height: 1.5; text-align: center;">
                سرور شما (به دلیل محدودیت‌های اینترنت/فیلترینگ دیتا‌سنتر) نتوانست مستقیماً به آدرس احراز هویت متصل شود.
              </p>

              <div style="background: #020617; border: 1px solid #1e293b; border-radius: 8px; padding: 1rem; margin-bottom: 1.25rem;">
                <p style="color: #38bdf8; font-size: 0.8rem; font-weight: bold; margin: 0 0 0.5rem;">
                  راهکار فوری (دریافت با مرورگر خودتان):
                </p>
                <ol style="color: #cbd5e1; font-size: 0.75rem; padding-right: 1.25rem; margin: 0 0 0.75rem; line-height: 1.6;">
                  <li>روی دکمه زیر کلیک کنید تا لینک مستقیم در تب جدید باز شود:</li>
                  <div style="margin: 0.5rem 0;">
                    <a href="${tokenUrl}" target="_blank" style="display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 0.4rem 0.85rem; border-radius: 6px; font-size: 0.75rem; font-weight: bold;">
                      باز کردن لینک دریافت توکن در تب جدید
                    </a>
                  </div>
                  <li>متن داخل accessToken را کپی کرده و در کادر زیر قرار دهید:</li>
                </ol>

                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                  <input
                    id="manualTokenInput"
                    type="text"
                    placeholder="مقدار accessToken را اینجا Paste کنید..."
                    dir="ltr"
                    style="width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #334155; color: #f8fafc; padding: 0.5rem; border-radius: 6px; font-size: 0.75rem; font-family: monospace;"
                  />
                  <button
                    onclick="submitManualToken()"
                    id="saveTokenBtn"
                    style="background: #10b981; color: #fff; border: none; padding: 0.5rem; border-radius: 6px; font-size: 0.8rem; font-weight: bold; cursor: pointer;"
                  >
                    ذخیره توکن و ورود به برنامه
                  </button>
                  <p id="tokenStatus" style="font-size: 0.75rem; margin: 0.25rem 0 0; text-align: center; color: #94a3b8;"></p>
                </div>
              </div>

              <div style="text-align: center;">
                <button onclick="window.close()" style="background: #1e293b; color: #94a3b8; border: none; padding: 0.4rem 1rem; border-radius: 6px; font-size: 0.75rem; cursor: pointer;">بستن این پنجره</button>
              </div>
            </div>

            <script>
              async function submitManualToken() {
                const token = document.getElementById('manualTokenInput').value.trim();
                const status = document.getElementById('tokenStatus');
                const btn = document.getElementById('saveTokenBtn');
                if (!token) {
                  status.innerText = 'لطفاً توکن را وارد کنید.';
                  status.style.color = '#f87171';
                  return;
                }
                btn.disabled = true;
                btn.innerText = 'در حال ذخیره...';
                try {
                  const res = await fetch('/api/ctrader/connect-token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accessToken: token }),
                  });
                  if (!res.ok) throw new Error('خطا در ذخیره توکن');
                  status.innerText = 'توکن با موفقیت ذخیره شد!';
                  status.style.color = '#34d399';
                  if (window.opener) {
                    window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
                    setTimeout(() => window.close(), 600);
                  } else {
                    window.location.href = '/';
                  }
                } catch (e) {
                  btn.disabled = false;
                  btn.innerText = 'ذخیره توکن و ورود به برنامه';
                  status.innerText = 'خطا در ثبت توکن روی سرور: ' + e.message;
                  status.style.color = '#f87171';
                }
              }
            </script>
          </body>
        </html>
      `);
    }
  });

  // 3. Get Current State (Connection Status, Accounts, Symbols, Open Positions, Pending Orders)
  app.get('/api/ctrader/state', (_req, res) => {
    res.json(ctraderManager.getStateSnapshot());
  });

  // 4. Sync / Reconcile Account State from cTrader Open API
  app.post('/api/ctrader/sync', async (_req, res) => {
    try {
      await ctraderManager.reconcileAccount();
      res.json(ctraderManager.getStateSnapshot());
    } catch (err: any) {
      res.status(400).json({ error: err.message, state: ctraderManager.getStateSnapshot() });
    }
  });

  // 5. Connect via Direct Access Token or Switch Mode (Live API vs Sandbox)
  app.post('/api/ctrader/connect-token', async (req, res) => {
    try {
      const { accessToken, mode } = req.body;
      if (mode === 'sandbox') {
        ctraderManager.setMode('sandbox');
        res.json(ctraderManager.getStateSnapshot());
        return;
      }
      if (!accessToken) {
        res.status(400).json({ error: 'لطفاً Access Token معتبر وارد کنید.' });
        return;
      }
      await ctraderManager.setAccessToken(accessToken);
      res.json(ctraderManager.getStateSnapshot());
    } catch (err: any) {
      res.status(400).json({ error: err.message, state: ctraderManager.getStateSnapshot() });
    }
  });

  // 6. Select Active cTrader Account (ctidTraderAccountId)
  app.post('/api/ctrader/select-account', async (req, res) => {
    try {
      const { ctidTraderAccountId } = req.body;
      await ctraderManager.selectAccount(Number(ctidTraderAccountId));
      res.json(ctraderManager.getStateSnapshot());
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 6.1. Adjust Sandbox Demo Balance
  app.post('/api/ctrader/sandbox/balance', (req, res) => {
    try {
      const { balance } = req.body;
      const amount = parseFloat(balance);
      if (isNaN(amount) || amount <= 0) {
        res.status(400).json({ error: 'مبلغ بالانس باید بزرگتر از صفر باشد.' });
        return;
      }
      ctraderManager.setSandboxBalance(amount);
      res.json(ctraderManager.getStateSnapshot());
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 6.2. Update Symbol Reference Price (For live simulation & testing)
  app.post('/api/ctrader/symbol/price', (req, res) => {
    try {
      const { symbolId, price } = req.body;
      const parsedPrice = parseFloat(price);
      if (isNaN(parsedPrice) || parsedPrice <= 0) {
        res.status(400).json({ error: 'قیمت نماد باید بزرگتر از صفر باشد.' });
        return;
      }
      const success = ctraderManager.updateSymbolPrice(Number(symbolId), parsedPrice);
      if (!success) {
        res.status(404).json({ error: 'نماد مورد نظر یافت نشد.' });
        return;
      }
      res.json(ctraderManager.getStateSnapshot());
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 7. Create New Order (Market / Limit / Stop) -> ProtoOANewOrderReq (2106)
  app.post('/api/ctrader/orders/new', async (req, res) => {
    try {
      const result = await ctraderManager.placeNewOrder(req.body);
      res.json({ result, state: ctraderManager.getStateSnapshot() });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 8. Amend Open Position SL/TP -> ProtoOAAmendPositionSLTPReq (2110)
  app.put('/api/ctrader/positions/:positionId', async (req, res) => {
    try {
      const positionId = Number(req.params.positionId);
      const { stopLoss, takeProfit } = req.body;
      const result = await ctraderManager.amendPosition({
        positionId,
        stopLoss: stopLoss !== undefined && stopLoss !== '' ? Number(stopLoss) : null,
        takeProfit: takeProfit !== undefined && takeProfit !== '' ? Number(takeProfit) : null,
      });
      res.json({ result, state: ctraderManager.getStateSnapshot() });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 9. Amend Pending Order -> ProtoOAAmendOrderReq (2109)
  app.put('/api/ctrader/orders/:orderId', async (req, res) => {
    try {
      const orderId = Number(req.params.orderId);
      const { volumeLots, limitPrice, stopPrice, stopLoss, takeProfit } = req.body;
      const result = await ctraderManager.amendPendingOrder({
        orderId,
        volumeLots: Number(volumeLots),
        limitPrice: limitPrice ? Number(limitPrice) : null,
        stopPrice: stopPrice ? Number(stopPrice) : null,
        stopLoss: stopLoss ? Number(stopLoss) : null,
        takeProfit: takeProfit ? Number(takeProfit) : null,
      });
      res.json({ result, state: ctraderManager.getStateSnapshot() });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 10. Close Open Position -> ProtoOAClosePositionReq (2111)
  app.post('/api/ctrader/positions/:positionId/close', async (req, res) => {
    try {
      const positionId = Number(req.params.positionId);
      const { volumeLots } = req.body || {};
      const result = await ctraderManager.closePosition(
        positionId,
        volumeLots ? Number(volumeLots) : undefined
      );
      res.json({ result, state: ctraderManager.getStateSnapshot() });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 11. Cancel Pending Order -> ProtoOACancelOrderReq (2108)
  app.delete('/api/ctrader/orders/:orderId', async (req, res) => {
    try {
      const orderId = Number(req.params.orderId);
      const result = await ctraderManager.cancelOrder(orderId);
      res.json({ result, state: ctraderManager.getStateSnapshot() });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  if (process.env.CTRADER_ACCESS_TOKEN && process.env.CTRADER_CLIENT_ID && process.env.CTRADER_CLIENT_SECRET) {
    ctraderManager.setAccessToken(process.env.CTRADER_ACCESS_TOKEN).catch((err) => {
      console.warn('Initial cTrader auto-connect failed:', err.message);
    });
  }

  const port = 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`cTrader Order Desk server running on http://0.0.0.0:${port}`);
  });
}

startServer();


