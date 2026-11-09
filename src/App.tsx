import React, { useEffect, useState, useMemo } from 'react';
import {
  RefreshCw,
  ArrowUpRight,
  ArrowDownRight,
  Check,
  Copy,
  AlertCircle,
  Search,
  Trash2,
  Edit3,
  PlusCircle,
  ExternalLink,
  ShieldCheck,
  Radio,
  Sliders,
  X,
} from 'lucide-react';

interface CTraderAccount {
  ctidTraderAccountId: number;
  isLive: boolean;
  traderLogin: number;
  brokerTitleShort?: string;
}

interface CTraderSymbol {
  symbolId: number;
  symbolName: string;
  digits: number;
  pipPosition: number;
  lotSize?: number;
  minVolume?: number;
  stepVolume?: number;
  description: string;
  referencePrice: number;
}

interface CTraderPosition {
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

interface CTraderPendingOrder {
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

interface CredentialsStatus {
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasAccessToken: boolean;
  mode: 'live_api' | 'sandbox';
  selectedAccountId: number | null;
  isLiveEnvironment: boolean;
  accounts: CTraderAccount[];
  lastError: string | null;
}

export default function App() {
  const [status, setStatus] = useState<CredentialsStatus | null>(null);
  const [symbols, setSymbols] = useState<CTraderSymbol[]>([]);
  const [positions, setPositions] = useState<CTraderPosition[]>([]);
  const [pendingOrders, setPendingOrders] = useState<CTraderPendingOrder[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);

  // Active view filters
  const [activeTab, setActiveTab] = useState<'positions' | 'orders'>('positions');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sideFilter, setSideFilter] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');

  // Connection settings modal
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [manualToken, setManualToken] = useState<string>('');
  const [copiedCallback, setCopiedCallback] = useState<boolean>(false);

  // Feedback banner
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Unified Order / Edit Form State
  const [formMode, setFormMode] = useState<'new' | 'edit'>('new');
  const [editTargetType, setEditTargetType] = useState<'position' | 'order'>('position');
  const [selectedEditId, setSelectedEditId] = useState<number | null>(null);

  const [symbolId, setSymbolId] = useState<number>(41); // Default Gold XAUUSD
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT' | 'STOP'>('MARKET');
  const [tradeSide, setTradeSide] = useState<'BUY' | 'SELL'>('BUY');
  const [volumeLots, setVolumeLots] = useState<string>('0.10');
  const [entryPrice, setEntryPrice] = useState<string>('');
  const [stopLoss, setStopLoss] = useState<string>('');
  const [takeProfit, setTakeProfit] = useState<string>('');
  const [comment, setComment] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  const redirectUri = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/auth/callback`;
  }, []);

  const showFeedback = (type: 'success' | 'error', message: string) => {
    setFeedback({ type, message });
    setTimeout(() => {
      setFeedback((prev) => (prev?.message === message ? null : prev));
    }, 5000);
  };

  const fetchState = async () => {
    try {
      const res = await fetch('/api/ctrader/state');
      if (!res.ok) throw new Error('خطا در دریافت وضعیت');
      const data = await res.json();
      setStatus(data.status);
      const loadedSymbols: CTraderSymbol[] = data.symbols || [];
      setSymbols(loadedSymbols);
      if (loadedSymbols.length > 0 && !loadedSymbols.some((s) => s.symbolId === Number(symbolId))) {
        setSymbolId(loadedSymbols[0].symbolId);
      }
      setPositions(data.positions || []);
      setPendingOrders(data.pendingOrders || []);
    } catch (err: any) {
      showFeedback('error', err.message || 'خطا در ارتباط با سرور');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchState();
  }, []);

  // Listen for OAuth completion
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        showFeedback('success', 'اتصال به حساب پروداکشن cTrader با موفقیت برقرار شد.');
        setShowSettingsModal(false);
        fetchState();
      } else if (event.data?.type === 'OAUTH_AUTH_ERROR') {
        showFeedback('error', `خطا در اتصال: ${event.data?.error || 'نامشخص'}`);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const selectedSymbol = useMemo(() => {
    return symbols.find((s) => s.symbolId === Number(symbolId)) || symbols[0];
  }, [symbols, symbolId]);

  // Adjust default price for pending orders
  useEffect(() => {
    if (formMode === 'new' && selectedSymbol && orderType !== 'MARKET' && !entryPrice) {
      setEntryPrice(selectedSymbol.referencePrice.toFixed(selectedSymbol.digits));
    }
  }, [selectedSymbol, orderType, formMode]);

  const loadPositionIntoEdit = (pos: CTraderPosition) => {
    setFormMode('edit');
    setEditTargetType('position');
    setSelectedEditId(pos.positionId);
    setSymbolId(pos.symbolId);
    setTradeSide(pos.tradeSide);
    setVolumeLots(pos.volumeLots.toFixed(2));
    setEntryPrice(pos.entryPrice.toString());
    setStopLoss(pos.stopLoss !== null ? pos.stopLoss.toString() : '');
    setTakeProfit(pos.takeProfit !== null ? pos.takeProfit.toString() : '');
    setComment(pos.comment || '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const loadOrderIntoEdit = (ord: CTraderPendingOrder) => {
    setFormMode('edit');
    setEditTargetType('order');
    setSelectedEditId(ord.orderId);
    setSymbolId(ord.symbolId);
    setOrderType(ord.orderType);
    setTradeSide(ord.tradeSide);
    setVolumeLots(ord.volumeLots.toFixed(2));
    const target = ord.orderType === 'LIMIT' ? ord.limitPrice : ord.stopPrice;
    setEntryPrice(target !== null ? target.toString() : '');
    setStopLoss(ord.stopLoss !== null ? ord.stopLoss.toString() : '');
    setTakeProfit(ord.takeProfit !== null ? ord.takeProfit.toString() : '');
    setComment(ord.comment || '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const resetToNewOrder = () => {
    setFormMode('new');
    setSelectedEditId(null);
    setStopLoss('');
    setTakeProfit('');
    setComment('');
    if (selectedSymbol) {
      setEntryPrice(selectedSymbol.referencePrice.toFixed(selectedSymbol.digits));
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/ctrader/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در همگام‌سازی');
      setStatus(data.status);
      setSymbols(data.symbols || []);
      setPositions(data.positions || []);
      setPendingOrders(data.pendingOrders || []);
      showFeedback('success', 'اطلاعات با سرور cTrader بروز شد.');
    } catch (err: any) {
      showFeedback('error', err.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleConnectOAuth = async () => {
    try {
      const res = await fetch(`/api/auth/url?redirect_uri=${encodeURIComponent(redirectUri)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ایجاد لینک اتصال OAuth');
      const win = window.open(data.url, 'ctrader_oauth', 'width=580,height=720');
      if (!win) {
        showFeedback('error', 'پاپ‌آپ توسط مرورگر بسته شد. لطفاً اجازه باز شدن پاپ‌آپ را بدهید.');
      }
    } catch (err: any) {
      showFeedback('error', err.message);
    }
  };

  const handleConnectToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualToken.trim()) {
      showFeedback('error', 'توکن دسترسی را وارد کنید.');
      return;
    }
    setSyncing(true);
    try {
      const res = await fetch('/api/ctrader/connect-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: manualToken.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در اتصال به توکن');
      setStatus(data.status);
      setSymbols(data.symbols || []);
      setPositions(data.positions || []);
      setPendingOrders(data.pendingOrders || []);
      setManualToken('');
      setShowSettingsModal(false);
      showFeedback('success', 'اتصال حساب با موفقیت برقرار شد.');
    } catch (err: any) {
      showFeedback('error', err.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleAccountSelect = async (accountId: number) => {
    setSyncing(true);
    try {
      const res = await fetch('/api/ctrader/select-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ctidTraderAccountId: accountId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در تغییر حساب');
      setStatus(data.status);
      setSymbols(data.symbols || []);
      setPositions(data.positions || []);
      setPendingOrders(data.pendingOrders || []);
      showFeedback('success', `حساب #${accountId} انتخاب شد.`);
    } catch (err: any) {
      showFeedback('error', err.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleSubmitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    const lots = parseFloat(volumeLots);
    if (isNaN(lots) || lots <= 0) {
      showFeedback('error', 'حجم معامله باید بزرگتر از صفر باشد.');
      return;
    }

    setSubmitting(true);
    try {
      if (formMode === 'new') {
        const payload: Record<string, unknown> = {
          symbolId: Number(symbolId),
          orderType,
          tradeSide,
          volumeLots: lots,
          stopLoss: stopLoss ? parseFloat(stopLoss) : null,
          takeProfit: takeProfit ? parseFloat(takeProfit) : null,
          comment: comment.trim(),
        };

        if (orderType === 'LIMIT') {
          if (!entryPrice) throw new Error('قیمت لیمیت را مشخص کنید.');
          payload.limitPrice = parseFloat(entryPrice);
        } else if (orderType === 'STOP') {
          if (!entryPrice) throw new Error('قیمت استاپ را مشخص کنید.');
          payload.stopPrice = parseFloat(entryPrice);
        }

        const res = await fetch('/api/ctrader/orders/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'خطا در ثبت معامله');

        setStatus(data.state.status);
        setPositions(data.state.positions);
        setPendingOrders(data.state.pendingOrders);
        setActiveTab(orderType === 'MARKET' ? 'positions' : 'orders');
        resetToNewOrder();
        showFeedback(
          'success',
          orderType === 'MARKET'
            ? `معامله ${tradeSide === 'BUY' ? 'خرید' : 'فروش'} ${selectedSymbol?.symbolName} ثبت شد.`
            : `سفارش شرطی ${orderType} ثبت شد.`
        );
      } else {
        if (!selectedEditId) throw new Error('موردی برای ویرایش انتخاب نشده است.');

        if (editTargetType === 'position') {
          const res = await fetch(`/api/ctrader/positions/${selectedEditId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              stopLoss: stopLoss !== '' ? parseFloat(stopLoss) : null,
              takeProfit: takeProfit !== '' ? parseFloat(takeProfit) : null,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'خطا در ویرایش پوزیشن');

          setStatus(data.state.status);
          setPositions(data.state.positions);
          setPendingOrders(data.state.pendingOrders);
          showFeedback('success', `پوزیشن #${selectedEditId} با موفقیت ویرایش شد.`);
        } else {
          const res = await fetch(`/api/ctrader/orders/${selectedEditId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              volumeLots: lots,
              limitPrice: orderType === 'LIMIT' && entryPrice ? parseFloat(entryPrice) : null,
              stopPrice: orderType === 'STOP' && entryPrice ? parseFloat(entryPrice) : null,
              stopLoss: stopLoss !== '' ? parseFloat(stopLoss) : null,
              takeProfit: takeProfit !== '' ? parseFloat(takeProfit) : null,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'خطا در ویرایش سفارش');

          setStatus(data.state.status);
          setPositions(data.state.positions);
          setPendingOrders(data.state.pendingOrders);
          showFeedback('success', `سفارش #${selectedEditId} ویرایش شد.`);
        }
      }
    } catch (err: any) {
      showFeedback('error', err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClosePosition = async (posId: number) => {
    try {
      const res = await fetch(`/api/ctrader/positions/${posId}/close`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در بستن معامله');
      setStatus(data.state.status);
      setPositions(data.state.positions);
      setPendingOrders(data.state.pendingOrders);
      if (selectedEditId === posId) resetToNewOrder();
      showFeedback('success', `پوزیشن #${posId} بسته شد.`);
    } catch (err: any) {
      showFeedback('error', err.message);
    }
  };

  const handleCancelOrder = async (ordId: number) => {
    try {
      const res = await fetch(`/api/ctrader/orders/${ordId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در لغو سفارش');
      setStatus(data.state.status);
      setPositions(data.state.positions);
      setPendingOrders(data.state.pendingOrders);
      if (selectedEditId === ordId) resetToNewOrder();
      showFeedback('success', `سفارش #${ordId} لغو شد.`);
    } catch (err: any) {
      showFeedback('error', err.message);
    }
  };

  const adjustVolume = (delta: number) => {
    const cur = parseFloat(volumeLots) || 0;
    const next = Math.max(0.01, Number((cur + delta).toFixed(2)));
    setVolumeLots(next.toFixed(2));
  };

  const filteredPositions = useMemo(() => {
    return positions.filter((p) => {
      const mSide = sideFilter === 'ALL' || p.tradeSide === sideFilter;
      const mSearch =
        !searchQuery.trim() ||
        p.symbolName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(p.positionId).includes(searchQuery);
      return mSide && mSearch;
    });
  }, [positions, sideFilter, searchQuery]);

  const filteredOrders = useMemo(() => {
    return pendingOrders.filter((o) => {
      const mSide = sideFilter === 'ALL' || o.tradeSide === sideFilter;
      const mSearch =
        !searchQuery.trim() ||
        o.symbolName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(o.orderId).includes(searchQuery);
      return mSide && mSearch;
    });
  }, [pendingOrders, sideFilter, searchQuery]);

  const copyCallbackUrl = () => {
    navigator.clipboard.writeText(redirectUri);
    setCopiedCallback(true);
    setTimeout(() => setCopiedCallback(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header - Clean, Production-Grade */}
      <header className="border-b border-slate-800 bg-slate-900/60 sticky top-0 z-20 backdrop-blur px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-emerald-400" />
            <span className="font-bold tracking-tight text-white text-base">cTrader Trading Desk</span>
          </div>
          <div className="hidden sm:flex items-center gap-2 text-xs text-slate-400 border-r border-slate-800 pr-4">
            <span>حساب:</span>
            <span className="font-mono text-slate-200">
              #{status?.selectedAccountId || '50091824'}
            </span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${status?.isLiveEnvironment ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-amber-950 text-amber-400 border border-amber-800'}`}>
              {status?.isLiveEnvironment ? 'LIVE' : 'DEMO'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {status?.accounts && status.accounts.length > 1 && (
            <select
              value={status.selectedAccountId || ''}
              onChange={(e) => handleAccountSelect(Number(e.target.value))}
              className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none"
            >
              {status.accounts.map((acc) => (
                <option key={acc.ctidTraderAccountId} value={acc.ctidTraderAccountId}>
                  {acc.brokerTitleShort || (acc.isLive ? 'Live' : 'Demo')} (#{acc.ctidTraderAccountId})
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors text-slate-300"
            title="همگام‌سازی اطلاعات"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">بروزرسانی</span>
          </button>

          <button
            type="button"
            onClick={() => setShowSettingsModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors"
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>تنظیمات حساب</span>
          </button>
        </div>
      </header>

      {/* Notification Banner */}
      {feedback && (
        <div
          className={`px-6 py-2.5 text-xs flex items-center justify-between border-b ${
            feedback.type === 'success'
              ? 'bg-emerald-950/70 border-emerald-800/80 text-emerald-200'
              : 'bg-rose-950/70 border-rose-800/80 text-rose-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{feedback.message}</span>
          </div>
          <button onClick={() => setFeedback(null)} className="text-slate-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Trading Workspace */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column (5 cols in RTL): Minimal & Fast Order Form */}
        <section className="lg:col-span-5 bg-slate-900/40 border border-slate-800/80 rounded-xl p-5 shadow-sm">
          <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
            <div>
              <h2 className="text-sm font-bold text-white">
                {formMode === 'new' ? 'ثبت معامله جدید' : 'ویرایش معامله'}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {formMode === 'new' ? 'ارسال سریع به cTrader Open API' : `در حال ویرایش ${editTargetType === 'position' ? 'پوزیشن باز' : 'سفارش در انتظار'} #${selectedEditId}`}
              </p>
            </div>

            {formMode === 'edit' && (
              <button
                type="button"
                onClick={resetToNewOrder}
                className="text-xs text-blue-400 hover:underline flex items-center gap-1"
              >
                <span>لغو و ثبت جدید</span>
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <form onSubmit={handleSubmitOrder} className="space-y-4">
            {/* Symbol Selection */}
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <label className="text-slate-300 font-medium">نماد معامله (Symbol)</label>
                {selectedSymbol && (
                  <span className="font-mono text-slate-400">
                    قیمت: {selectedSymbol.referencePrice.toFixed(selectedSymbol.digits)}
                  </span>
                )}
              </div>
              <select
                disabled={formMode === 'edit'}
                value={symbolId}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setSymbolId(id);
                  const sym = symbols.find((s) => s.symbolId === id);
                  if (sym) setEntryPrice(sym.referencePrice.toFixed(sym.digits));
                }}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-50"
              >
                {symbols.map((s) => (
                  <option key={s.symbolId} value={s.symbolId}>
                    {s.symbolName} — {s.description}
                  </option>
                ))}
              </select>
            </div>

            {/* Order Type & Side (For New Orders) */}
            {formMode === 'new' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">نوع سفارش</label>
                  <div className="grid grid-cols-3 gap-1 bg-slate-950 p-1 border border-slate-800 rounded-lg">
                    {(['MARKET', 'LIMIT', 'STOP'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => {
                          setOrderType(t);
                          if (t !== 'MARKET' && selectedSymbol && !entryPrice) {
                            setEntryPrice(selectedSymbol.referencePrice.toFixed(selectedSymbol.digits));
                          }
                        }}
                        className={`py-1 text-[11px] font-mono rounded transition-colors ${
                          orderType === t ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">جهت</label>
                  <div className="grid grid-cols-2 gap-1 bg-slate-950 p-1 border border-slate-800 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setTradeSide('BUY')}
                      className={`py-1 text-xs rounded transition-colors flex items-center justify-center gap-1 ${
                        tradeSide === 'BUY' ? 'bg-emerald-600 text-white font-semibold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <ArrowUpRight className="w-3.5 h-3.5" />
                      <span>خرید</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTradeSide('SELL')}
                      className={`py-1 text-xs rounded transition-colors flex items-center justify-center gap-1 ${
                        tradeSide === 'SELL' ? 'bg-rose-600 text-white font-semibold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <ArrowDownRight className="w-3.5 h-3.5" />
                      <span>فروش</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Volume */}
            {(formMode === 'new' || editTargetType === 'order') && (
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <label className="text-slate-300 font-medium">حجم معامله (Lot)</label>
                  <span className="font-mono text-slate-500 text-[11px]">
                    واحد پروتکل: {Math.round((parseFloat(volumeLots) || 0) * (selectedSymbol?.lotSize || 10_000_000)).toLocaleString('en-US')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={volumeLots}
                    onChange={(e) => setVolumeLots(e.target.value)}
                    dir="ltr"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => adjustVolume(-0.01)}
                      className="px-2 py-1.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded hover:bg-slate-800 text-slate-300"
                    >
                      -0.01
                    </button>
                    <button
                      type="button"
                      onClick={() => adjustVolume(0.01)}
                      className="px-2 py-1.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded hover:bg-slate-800 text-slate-300"
                    >
                      +0.01
                    </button>
                    <button
                      type="button"
                      onClick={() => adjustVolume(0.1)}
                      className="px-2 py-1.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded hover:bg-slate-800 text-slate-300"
                    >
                      +0.10
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Entry Price (for pending orders) */}
            {((formMode === 'new' && orderType !== 'MARKET') ||
              (formMode === 'edit' && editTargetType === 'order')) && (
              <div>
                <label className="block text-xs text-slate-300 font-medium mb-1.5">
                  قیمت ورود ({orderType})
                </label>
                <input
                  type="number"
                  step="any"
                  value={entryPrice}
                  onChange={(e) => setEntryPrice(e.target.value)}
                  placeholder={selectedSymbol ? selectedSymbol.referencePrice.toString() : '0.00'}
                  dir="ltr"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
            )}

            {/* SL / TP */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">حد ضرر (Stop Loss)</label>
                <input
                  type="number"
                  step="any"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  placeholder="بدون SL"
                  dir="ltr"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-rose-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">حد سود (Take Profit)</label>
                <input
                  type="number"
                  step="any"
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  placeholder="بدون TP"
                  dir="ltr"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            {/* Optional Comment */}
            {formMode === 'new' && (
              <div>
                <label className="block text-xs text-slate-400 mb-1">توضیح (اختیاری)</label>
                <input
                  type="text"
                  maxLength={50}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="مثال: Daily Key Level"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                />
              </div>
            )}

            {/* Submit Button */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={submitting}
                className={`w-full py-2.5 rounded-lg text-xs font-bold text-white transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 ${
                  formMode === 'edit'
                    ? 'bg-blue-600 hover:bg-blue-500'
                    : tradeSide === 'BUY'
                    ? 'bg-emerald-600 hover:bg-emerald-500'
                    : 'bg-rose-600 hover:bg-rose-500'
                }`}
              >
                {submitting ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : formMode === 'edit' ? (
                  <Edit3 className="w-3.5 h-3.5" />
                ) : (
                  <PlusCircle className="w-3.5 h-3.5" />
                )}
                <span>
                  {formMode === 'new'
                    ? `ثبت سفارش ${tradeSide === 'BUY' ? 'خرید' : 'فروش'} ${selectedSymbol?.symbolName || ''}`
                    : `تأیید ویرایش ${editTargetType === 'position' ? 'پوزیشن' : 'سفارش'} #${selectedEditId}`}
                </span>
              </button>
            </div>
          </form>
        </section>

        {/* Right Column (7 cols in RTL): Active Trades & Pending Orders Tables */}
        <section className="lg:col-span-7 bg-slate-900/40 border border-slate-800/80 rounded-xl p-5 shadow-sm space-y-4">
          {/* Table Header & Controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
            <div className="flex items-center gap-1 bg-slate-950 p-1 border border-slate-800 rounded-lg">
              <button
                type="button"
                onClick={() => setActiveTab('positions')}
                className={`px-3 py-1.5 text-xs rounded transition-colors ${
                  activeTab === 'positions' ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:text-white'
                }`}
              >
                پوزیشن‌های باز ({positions.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('orders')}
                className={`px-3 py-1.5 text-xs rounded transition-colors ${
                  activeTab === 'orders' ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:text-white'
                }`}
              >
                سفارش‌های در انتظار ({pendingOrders.length})
              </button>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute right-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="جستجو نماد..."
                  className="bg-slate-950 border border-slate-800 rounded-lg pr-7 pl-3 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500 w-28 sm:w-36"
                />
              </div>

              <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5">
                {(['ALL', 'BUY', 'SELL'] as const).map((side) => (
                  <button
                    key={side}
                    type="button"
                    onClick={() => setSideFilter(side)}
                    className={`px-2 py-1 text-[11px] font-mono rounded transition-colors ${
                      sideFilter === side ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {side === 'ALL' ? 'همه' : side}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Tab 1: Open Positions */}
          {activeTab === 'positions' && (
            <div>
              {loading ? (
                <div className="py-8 text-center text-xs text-slate-500">در حال دریافت اطلاعات...</div>
              ) : filteredPositions.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-500">
                  هیچ پوزیشن بازی وجود ندارد.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-right border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800/80 text-slate-400 font-medium">
                        <th className="py-2 px-2.5">نماد</th>
                        <th className="py-2 px-2.5">جهت / حجم</th>
                        <th className="py-2 px-2.5">ورود</th>
                        <th className="py-2 px-2.5">حد ضرر</th>
                        <th className="py-2 px-2.5">حد سود</th>
                        <th className="py-2 px-2.5 text-left">عملیات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/40">
                      {filteredPositions.map((p) => (
                        <tr
                          key={p.positionId}
                          className={`hover:bg-slate-800/30 transition-colors ${
                            selectedEditId === p.positionId && formMode === 'edit' ? 'bg-blue-950/20' : ''
                          }`}
                        >
                          <td className="py-2.5 px-2.5">
                            <span className="font-bold text-white">{p.symbolName}</span>
                            <span className="block text-[10px] text-slate-500 font-mono">#{p.positionId}</span>
                          </td>
                          <td className="py-2.5 px-2.5 font-mono">
                            <span className={p.tradeSide === 'BUY' ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                              {p.tradeSide}
                            </span>
                            <span className="text-slate-400 mr-1.5">{p.volumeLots.toFixed(2)} Lot</span>
                          </td>
                          <td className="py-2.5 px-2.5 font-mono text-slate-200" dir="ltr">
                            {p.entryPrice}
                          </td>
                          <td className="py-2.5 px-2.5 font-mono text-rose-400" dir="ltr">
                            {p.stopLoss ?? '—'}
                          </td>
                          <td className="py-2.5 px-2.5 font-mono text-emerald-400" dir="ltr">
                            {p.takeProfit ?? '—'}
                          </td>
                          <td className="py-2.5 px-2.5 text-left">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => loadPositionIntoEdit(p)}
                                className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-[11px] transition-colors"
                              >
                                ویرایش
                              </button>
                              <button
                                type="button"
                                onClick={() => handleClosePosition(p.positionId)}
                                className="px-2 py-1 bg-rose-950/80 hover:bg-rose-900 border border-rose-800/60 text-rose-300 rounded text-[11px] transition-colors"
                              >
                                بستن
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Pending Orders */}
          {activeTab === 'orders' && (
            <div>
              {loading ? (
                <div className="py-8 text-center text-xs text-slate-500">در حال دریافت اطلاعات...</div>
              ) : filteredOrders.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-500">
                  هیچ سفارش در انتظاری ثبت نشده است.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-right border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800/80 text-slate-400 font-medium">
                        <th className="py-2 px-2.5">نماد</th>
                        <th className="py-2 px-2.5">نوع / حجم</th>
                        <th className="py-2 px-2.5">قیمت</th>
                        <th className="py-2 px-2.5">حد ضرر</th>
                        <th className="py-2 px-2.5">حد سود</th>
                        <th className="py-2 px-2.5 text-left">عملیات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/40">
                      {filteredOrders.map((o) => {
                        const target = o.orderType === 'LIMIT' ? o.limitPrice : o.stopPrice;
                        return (
                          <tr
                            key={o.orderId}
                            className={`hover:bg-slate-800/30 transition-colors ${
                              selectedEditId === o.orderId && formMode === 'edit' ? 'bg-blue-950/20' : ''
                            }`}
                          >
                            <td className="py-2.5 px-2.5">
                              <span className="font-bold text-white">{o.symbolName}</span>
                              <span className="block text-[10px] text-slate-500 font-mono">#{o.orderId}</span>
                            </td>
                            <td className="py-2.5 px-2.5 font-mono">
                              <span className={o.tradeSide === 'BUY' ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                                {o.tradeSide} {o.orderType}
                              </span>
                              <span className="text-slate-400 mr-1.5">{o.volumeLots.toFixed(2)} Lot</span>
                            </td>
                            <td className="py-2.5 px-2.5 font-mono text-slate-200" dir="ltr">
                              {target ?? '—'}
                            </td>
                            <td className="py-2.5 px-2.5 font-mono text-rose-400" dir="ltr">
                              {o.stopLoss ?? '—'}
                            </td>
                            <td className="py-2.5 px-2.5 font-mono text-emerald-400" dir="ltr">
                              {o.takeProfit ?? '—'}
                            </td>
                            <td className="py-2.5 px-2.5 text-left">
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => loadOrderIntoEdit(o)}
                                  className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-[11px] transition-colors"
                                >
                                  ویرایش
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleCancelOrder(o.orderId)}
                                  className="px-2 py-1 bg-rose-950/80 hover:bg-rose-900 border border-rose-800/60 text-rose-300 rounded text-[11px] transition-colors"
                                >
                                  لغو
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      {/* Connection & OAuth Modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2 text-white font-bold text-sm">
                <ShieldCheck className="w-4 h-4 text-blue-400" />
                <span>اتصال حساب پروداکشن cTrader Open API</span>
              </div>
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Direct OAuth Button */}
            <div className="bg-slate-950 border border-slate-800 p-4 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-white">ورود خودکار با حساب cTrader ID</h4>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    اتصال سریع از طریق فرم رسمی ورود cTrader و دسترسی معامله
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleConnectOAuth}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-semibold transition-colors flex items-center gap-1.5"
                >
                  <span>ورود به حساب</span>
                  <ExternalLink className="w-3 h-3" />
                </button>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  آدرس بازگشت (Redirect URI) جهت درج در پنل cTrader:
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={redirectUri}
                    dir="ltr"
                    className="flex-1 bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-[11px] font-mono text-slate-300 select-all"
                  />
                  <button
                    type="button"
                    onClick={copyCallbackUrl}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs flex items-center gap-1"
                  >
                    {copiedCallback ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedCallback ? 'کپی شد' : 'کپی'}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Manual Token Option */}
            <form onSubmit={handleConnectToken} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  یا وارد کردن مستقیم Access Token پروداکشن
                </label>
                <input
                  type="password"
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                  placeholder="توکن دسترسی cTrader..."
                  dir="ltr"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <button
                type="submit"
                disabled={syncing}
                className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs rounded-lg transition-colors disabled:opacity-50"
              >
                ذخیره و اتصال با توکن
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
