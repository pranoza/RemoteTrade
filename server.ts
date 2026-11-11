import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import dotenv from 'dotenv';
import WebSocket from 'ws';

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
  stopLoss: number | null;
  takeProfit: number | null;
  swap: number;
  commission: number;
  comment: string;
  openTimestamp: number;
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
  private accessToken: string = process.env.CTRADER_ACCESS_TOKEN || '';
  private mode: 'live_api' | 'sandbox' = process.env.CTRADER_ACCESS_TOKEN ? 'live_api' : 'sandbox';
  private accounts: CTraderAccount[] = [];
  private selectedAccountId: number | null = null;
  private isLiveEnvironment: boolean = false;
  private symbols: CTraderSymbol[] = [...DEFAULT_SYMBOLS];
  private positions: CTraderPosition[] = [
    {
      positionId: 78492011,
      symbolId: 41,
      symbolName: 'XAUUSD',
      tradeSide: 'BUY',
      volumeLots: 0.50,
      volumeProtocol: lotsToProtocolVolume(0.50, DEFAULT_SYMBOLS[3]),
      entryPrice: 2741.50,
      stopLoss: 2732.00,
      takeProfit: 2765.00,
      swap: -1.45,
      commission: -3.50,
      comment: 'Gold breakout setup',
      openTimestamp: Date.now() - 3600 * 1000 * 3,
    },
    {
      positionId: 78492045,
      symbolId: 1,
      symbolName: 'EURUSD',
      tradeSide: 'SELL',
      volumeLots: 1.00,
      volumeProtocol: lotsToProtocolVolume(1.00, DEFAULT_SYMBOLS[0]),
      entryPrice: 1.08620,
      stopLoss: 1.08950,
      takeProfit: 1.07900,
      swap: 0.20,
      commission: -7.00,
      comment: 'London session short',
      openTimestamp: Date.now() - 3600 * 1000 * 1.5,
    },
  ];
  private pendingOrders: CTraderPendingOrder[] = [
    {
      orderId: 99104512,
      symbolId: 1,
      symbolName: 'EURUSD',
      orderType: 'LIMIT',
      tradeSide: 'BUY',
      volumeLots: 0.25,
      volumeProtocol: lotsToProtocolVolume(0.25, DEFAULT_SYMBOLS[0]),
      limitPrice: 1.08100,
      stopPrice: null,
      stopLoss: 1.07750,
      takeProfit: 1.08850,
      comment: 'Demand zone pullback',
      openTimestamp: Date.now() - 1800 * 1000,
    },
    {
      orderId: 99104589,
      symbolId: 41,
      symbolName: 'XAUUSD',
      orderType: 'STOP',
      tradeSide: 'BUY',
      volumeLots: 0.20,
      volumeProtocol: lotsToProtocolVolume(0.20, DEFAULT_SYMBOLS[3]),
      limitPrice: null,
      stopPrice: 2755.00,
      stopLoss: 2744.00,
      takeProfit: 2780.00,
      comment: 'Momentum continuation',
      openTimestamp: Date.now() - 900 * 1000,
    },
  ];
  private lastError: string | null = null;

  public getCredentialsStatus() {
    const clientId = process.env.CTRADER_CLIENT_ID || '';
    const clientSecret = process.env.CTRADER_CLIENT_SECRET || '';
    return {
      hasClientId: Boolean(clientId && clientId !== 'MY_CTRADER_CLIENT_ID'),
      hasClientSecret: Boolean(clientSecret && clientSecret !== 'MY_CTRADER_CLIENT_SECRET'),
      hasAccessToken: Boolean(this.accessToken),
      mode: this.mode,
      selectedAccountId: this.selectedAccountId || (this.mode === 'sandbox' ? 50091824 : null),
      isLiveEnvironment: this.isLiveEnvironment,
      accounts: this.mode === 'sandbox'
        ? [
            { ctidTraderAccountId: 50091824, isLive: false, traderLogin: 8841209, brokerTitleShort: 'cTrader Demo (Sandbox)' },
          ]
        : this.accounts,
      lastError: this.lastError,
    };
  }

  public async setAccessToken(token: string) {
    this.accessToken = token.trim();
    this.lastError = null;
    if (this.accessToken) {
      this.mode = 'live_api';
      await this.fetchAccountsFromCTrader();
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
    const clientId = process.env.CTRADER_CLIENT_ID;
    const clientSecret = process.env.CTRADER_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('متغیرهای محیطی CTRADER_CLIENT_ID و CTRADER_CLIENT_SECRET تنظیم نشده‌اند.');
    }

    const endpoint = isLive ? 'wss://live.ctraderapi.com:5036' : 'wss://demo.ctraderapi.com:5036';

    return new Promise<T>((resolve, reject) => {
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
        ws.close();
        reject(new Error('مهلت زمانی اتصال به سرور cTrader به پایان رسید (Timeout).'));
      }, 15000);

      let msgCounter = 1;

      const sendRequest = (
        payloadType: number,
        payload: Record<string, unknown>,
        expectedResTypes?: number[]
      ): Promise<{ payloadType: number; payload: any }> => {
        return new Promise((resReq, rejReq) => {
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
          const msg = JSON.parse(data.toString());
          if (msg.payloadType === PAYLOAD_TYPES.HEARTBEAT_EVENT) {
            return;
          }

          const clientMsgId = msg.clientMsgId;
          if (clientMsgId && pendingRequests.has(clientMsgId)) {
            const req = pendingRequests.get(clientMsgId)!;
            if (
              msg.payloadType === PAYLOAD_TYPES.OA_ERROR_RES ||
              msg.payloadType === PAYLOAD_TYPES.ORDER_ERROR_EVENT ||
              msg.payload?.errorCode
            ) {
              pendingRequests.delete(clientMsgId);
              const errDesc = msg.payload?.description || msg.payload?.errorCode || 'خطا از سمت سرور cTrader';
              req.reject(new Error(String(errDesc)));
              return;
            }
            pendingRequests.delete(clientMsgId);
            req.resolve({ payloadType: msg.payloadType, payload: msg.payload });
          } else {
            // Match by expectedResTypes if server omitted clientMsgId on ExecutionEvent
            for (const [key, req] of pendingRequests.entries()) {
              if (req.expectedResTypes && req.expectedResTypes.includes(msg.payloadType)) {
                pendingRequests.delete(key);
                if (msg.payload?.errorCode) {
                  req.reject(new Error(`${msg.payload.errorCode}: ${msg.payload.description || ''}`));
                } else {
                  req.resolve({ payloadType: msg.payloadType, payload: msg.payload });
                }
                break;
              }
            }
          }
        } catch (err) {
          // Ignore malformed frame
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`خطای ارتباط WebSocket با cTrader: ${err.message}`));
      });

      ws.on('open', async () => {
        try {
          // Step 1: Authenticate Application (2100 -> 2101)
          await sendRequest(PAYLOAD_TYPES.APPLICATION_AUTH_REQ, {
            clientId,
            clientSecret,
          });

          const result = await handler(sendRequest);
          clearTimeout(timeout);
          ws.close();
          resolve(result);
        } catch (err: any) {
          clearTimeout(timeout);
          ws.close();
          reject(err);
        }
      });
    });
  }

  public async fetchAccountsFromCTrader(): Promise<CTraderAccount[]> {
    if (!this.accessToken) {
      throw new Error('توکن دسترسی (Access Token) وارد نشده است.');
    }

    try {
      // First try live server endpoint, if it fails or returns 0 accounts, try demo
      let accounts: CTraderAccount[] = [];
      try {
        accounts = await this.executeWithWebSocket(true, async (sendRequest) => {
          const res = await sendRequest(PAYLOAD_TYPES.GET_ACCOUNTS_BY_TOKEN_REQ, {
            accessToken: this.accessToken,
          });
          const list = res.payload?.ctidTraderAccount || [];
          return list.map((acc: any) => ({
            ctidTraderAccountId: Number(acc.ctidTraderAccountId),
            isLive: Boolean(acc.isLive),
            traderLogin: Number(acc.traderLogin || acc.ctidTraderAccountId),
            brokerTitleShort: acc.brokerTitleShort || (acc.isLive ? 'cTrader Live' : 'cTrader Demo'),
          }));
        });
      } catch {
        // Fallback to demo endpoint
        accounts = await this.executeWithWebSocket(false, async (sendRequest) => {
          const res = await sendRequest(PAYLOAD_TYPES.GET_ACCOUNTS_BY_TOKEN_REQ, {
            accessToken: this.accessToken,
          });
          const list = res.payload?.ctidTraderAccount || [];
          return list.map((acc: any) => ({
            ctidTraderAccountId: Number(acc.ctidTraderAccountId),
            isLive: Boolean(acc.isLive),
            traderLogin: Number(acc.traderLogin || acc.ctidTraderAccountId),
            brokerTitleShort: acc.brokerTitleShort || (acc.isLive ? 'cTrader Live' : 'cTrader Demo'),
          }));
        });
      }

      this.accounts = accounts;
      if (accounts.length > 0) {
        if (!this.selectedAccountId || !accounts.some((a) => a.ctidTraderAccountId === this.selectedAccountId)) {
          this.selectedAccountId = accounts[0].ctidTraderAccountId;
          this.isLiveEnvironment = accounts[0].isLive;
        } else {
          const cur = accounts.find((a) => a.ctidTraderAccountId === this.selectedAccountId);
          if (cur) this.isLiveEnvironment = cur.isLive;
        }
        await this.reconcileAccount();
      }
      this.lastError = null;
      return accounts;
    } catch (err: any) {
      this.lastError = err.message;
      throw err;
    }
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
          return {
            positionId: Number(p.positionId),
            symbolId: symId,
            symbolName: symObj?.symbolName || `SYM#${symId}`,
            tradeSide: side,
            volumeLots: protocolVolumeToLots(volProto, symObj),
            volumeProtocol: volProto,
            entryPrice: Number(p.price || 0),
            stopLoss: p.stopLoss ? Number(p.stopLoss) : null,
            takeProfit: p.takeProfit ? Number(p.takeProfit) : null,
            swap: Number(p.swap || 0) / 100,
            commission: Number(p.commission || 0) / 100,
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
      return {
        symbols: this.symbols,
        positions: this.positions,
        pendingOrders: this.pendingOrders,
      };
    } catch (err: any) {
      this.lastError = err.message;
      throw err;
    }
  }

  public getStateSnapshot() {
    return {
      status: this.getCredentialsStatus(),
      symbols: this.symbols,
      positions: this.positions,
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
        const newPos: CTraderPosition = {
          positionId: Math.floor(78500000 + Math.random() * 900000),
          symbolId: symbol.symbolId,
          symbolName: symbol.symbolName,
          tradeSide: params.tradeSide,
          volumeLots: Number(params.volumeLots),
          volumeProtocol,
          entryPrice: symbol.referencePrice,
          stopLoss: params.stopLoss ? Number(params.stopLoss) : null,
          takeProfit: params.takeProfit ? Number(params.takeProfit) : null,
          swap: 0,
          commission: Number((-7 * params.volumeLots).toFixed(2)),
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
      return { type: 'POSITION_CLOSED', item: removed };
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

  // 1. OAuth Authorization URL endpoint
  app.get('/api/auth/url', (req, res) => {
    const clientId = process.env.CTRADER_CLIENT_ID;
    if (!clientId) {
      res.status(400).json({
        error: 'متغیر محیطی CTRADER_CLIENT_ID در تنظیمات پروژه تعریف نشده است.',
      });
      return;
    }

    const baseAppUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
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

  // 2. OAuth Callback Handler (Popup postMessage flow)
  app.get(['/auth/callback', '/auth/callback/'], async (req, res) => {
    const code = req.query.code as string | undefined;
    const errorDesc = req.query.error_description || req.query.error;

    if (errorDesc || !code) {
      res.send(`
        <!doctype html>
        <html lang="fa" dir="rtl">
          <head><meta charset="utf-8"><title>خطا در احراز هویت cTrader</title></head>
          <body style="font-family: sans-serif; background: #020617; color: #f8fafc; padding: 2rem; text-align: center;">
            <h3>خطا در اتصال به cTrader</h3>
            <p>${errorDesc || 'کد احراز هویت دریافت نشد.'}</p>
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

    try {
      const clientId = process.env.CTRADER_CLIENT_ID || '';
      const clientSecret = process.env.CTRADER_CLIENT_SECRET || '';
      const baseAppUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const redirectUri = `${baseAppUrl}/auth/callback`;

      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      });

      const tokenResponse = await fetch(`https://openapi.ctrader.com/apps/token?${tokenParams.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      const tokenData: any = await tokenResponse.json();
      const accessToken = tokenData.accessToken || tokenData.access_token;

      if (!accessToken) {
        throw new Error(tokenData.description || tokenData.error_description || 'توکن دسترسی از cTrader دریافت نشد.');
      }

      await ctraderManager.setAccessToken(accessToken);

      res.send(`
        <!doctype html>
        <html lang="fa" dir="rtl">
          <head><meta charset="utf-8"><title>اتصال موفق به cTrader</title></head>
          <body style="font-family: sans-serif; background: #020617; color: #f8fafc; padding: 2rem; text-align: center;">
            <h3>اتصال به اکانت cTrader با موفقیت انجام شد.</h3>
            <p>این پنجره به صورت خودکار بسته می‌شود...</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
          </body>
        </html>
      `);
    } catch (err: any) {
      res.send(`
        <!doctype html>
        <html lang="fa" dir="rtl">
          <head><meta charset="utf-8"><title>خطا در دریافت توکن cTrader</title></head>
          <body style="font-family: sans-serif; background: #020617; color: #f8fafc; padding: 2rem; text-align: center;">
            <h3>خطا در تبادل توکن با cTrader</h3>
            <p>${err.message}</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: ${JSON.stringify(err.message)} }, '*');
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


