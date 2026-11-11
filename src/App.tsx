import React, { useEffect, useState, useMemo, useCallback } from 'react';
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
  Wallet,
  TrendingUp,
  Layers,
  Coins,
  Lock,
  User,
  LogOut,
  Eye,
  EyeOff,
  KeyRound,
  SlidersHorizontal,
  Activity,
} from 'lucide-react';

interface CTraderAccount {
  ctidTraderAccountId: number;
  isLive: boolean;
  traderLogin: number;
  brokerTitleShort?: string;
  balance?: number;
  currency?: string;
  leverage?: number;
  freeMargin?: number;
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
  currentPrice?: number;
  grossProfit?: number;
  netProfit?: number;
  pips?: number;
  stopLoss: number | null;
  takeProfit: number | null;
  swap: number;
  commission: number;
  comment: string;
  openTimestamp: number;
}

export function computeTradePnL(
  p: CTraderPosition,
  symbol?: CTraderSymbol,
  overridePrice?: number
) {
  const curPrice =
    overridePrice !== undefined && overridePrice > 0
      ? overridePrice
      : (p.currentPrice ?? symbol?.referencePrice ?? p.entryPrice);
  const priceDiff = p.tradeSide === 'BUY' ? curPrice - p.entryPrice : p.entryPrice - curPrice;
  const upper = (symbol?.symbolName || p.symbolName || '').toUpperCase();
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

  const grossProfit = Number((priceDiff * p.volumeLots * unitsPerLot).toFixed(2));
  const netProfit = Number((grossProfit + (p.commission || 0) + (p.swap || 0)).toFixed(2));
  const pipMultiplier =
    symbol?.pipPosition !== undefined
      ? Math.pow(10, symbol.pipPosition)
      : (symbol?.digits ? Math.pow(10, symbol.digits - 1) : 10000);
  const pips = Number((priceDiff * pipMultiplier).toFixed(1));
  const pct = p.entryPrice > 0 ? Number(((priceDiff / p.entryPrice) * 100).toFixed(2)) : 0;

  return {
    currentPrice: curPrice,
    grossProfit,
    netProfit,
    pips,
    pct,
  };
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
  clientIdMasked?: string;
  hasAccessToken: boolean;
  mode: 'live_api' | 'sandbox';
  selectedAccountId: number | null;
  isLiveEnvironment: boolean;
  accounts: CTraderAccount[];
  activeAccount?: CTraderAccount;
  lastError: string | null;
}

export default function App() {
  const [status, setStatus] = useState<CredentialsStatus | null>(null);
  const [symbols, setSymbols] = useState<CTraderSymbol[]>([]);
  const [positions, setPositions] = useState<CTraderPosition[]>([]);
  const [pendingOrders, setPendingOrders] = useState<CTraderPendingOrder[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);

  // Authentication State (Environment Variables Login)
  const [authToken, setAuthToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('ctrader_auth_token');
    }
    return null;
  });
  const [authUser, setAuthUser] = useState<{ username: string } | null>(null);
  const [authChecking, setAuthChecking] = useState<boolean>(true);
  const [loginUsername, setLoginUsername] = useState<string>('');
  const [loginPassword, setLoginPassword] = useState<string>('');
  const [loginShowPassword, setLoginShowPassword] = useState<boolean>(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginSubmitting, setLoginSubmitting] = useState<boolean>(false);

  // Price Simulation State (For sandbox / live testing)
  const [showPriceSimulator, setShowPriceSimulator] = useState<boolean>(false);
  const [simSymbolId, setSimSymbolId] = useState<number>(41);
  const [simPriceInput, setSimPriceInput] = useState<string>('');
  const [simulatingPrice, setSimulatingPrice] = useState<boolean>(false);

  // Auto-refresh timer toggle
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);

  // Active view filters
  const [activeTab, setActiveTab] = useState<'positions' | 'orders'>('positions');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sideFilter, setSideFilter] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');

  // Connection settings modal
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [inputClientId, setInputClientId] = useState<string>('');
  const [inputClientSecret, setInputClientSecret] = useState<string>('');
  const [manualToken, setManualToken] = useState<string>('');
  const [copiedCallback, setCopiedCallback] = useState<boolean>(false);
  const [customBalanceInput, setCustomBalanceInput] = useState<string>('');
  const [updatingBalance, setUpdatingBalance] = useState<boolean>(false);

  // Feedback banner
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const showFeedback = (type: 'success' | 'error', message: string) => {
    setFeedback({ type, message });
    setTimeout(() => {
      setFeedback((prev) => (prev?.message === message ? null : prev));
    }, 5000);
  };

  // Authenticated fetch wrapper
  const authFetch = useCallback(
    async (url: string, options: RequestInit = {}) => {
      const token = authToken || localStorage.getItem('ctrader_auth_token');
      const headers = new Headers(options.headers || {});
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      const res = await fetch(url, { ...options, headers });
      if (res.status === 401 && !url.includes('/api/auth/login')) {
        setAuthToken(null);
        setAuthUser(null);
        localStorage.removeItem('ctrader_auth_token');
        showFeedback('error', 'نشست کاربری شما پایان یافته است. لطفاً مجدداً لاگین کنید.');
      }
      return res;
    },
    [authToken]
  );

  // Check existing session token on mount
  const checkAuth = useCallback(async () => {
    const token = localStorage.getItem('ctrader_auth_token');
    if (!token) {
      setAuthChecking(false);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.authenticated && data.user) {
        setAuthUser(data.user);
        setAuthToken(token);
      } else {
        localStorage.removeItem('ctrader_auth_token');
        setAuthToken(null);
        setAuthUser(null);
      }
    } catch {
      localStorage.removeItem('ctrader_auth_token');
      setAuthToken(null);
      setAuthUser(null);
    } finally {
      setAuthChecking(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginUsername.trim() || !loginPassword) {
      setLoginError('لطفاً نام کاربری و رمز عبور را وارد کنید.');
      return;
    }
    setLoginSubmitting(true);
    setLoginError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: loginUsername.trim(),
          password: loginPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'نام کاربری یا رمز عبور اشتباه است.');
      }
      localStorage.setItem('ctrader_auth_token', data.token);
      setAuthToken(data.token);
      setAuthUser(data.user);
      setLoginPassword('');
      showFeedback('success', `خوش آمدید، ${data.user.username}`);
    } catch (err: any) {
      setLoginError(err.message || 'خطا در ورود به سیستم');
    } finally {
      setLoginSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await authFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore
    }
    localStorage.removeItem('ctrader_auth_token');
    setAuthToken(null);
    setAuthUser(null);
    setStatus(null);
    setPositions([]);
    setPendingOrders([]);
    showFeedback('success', 'با موفقیت خارج شدید.');
  };

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setSyncing(true);
    try {
      const res = await authFetch('/api/ctrader/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: inputClientId.trim() || undefined,
          clientSecret: inputClientSecret.trim() || undefined,
          accessToken: manualToken.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ذخیره اطلاعات');
      setStatus(data.status);
      setSymbols(data.symbols || []);
      setPositions(data.positions || []);
      setPendingOrders(data.pendingOrders || []);
      showFeedback('success', 'اطلاعات با موفقیت ذخیره شد.');
      if (manualToken.trim()) {
        setShowSettingsModal(false);
      }
    } catch (err: any) {
      showFeedback('error', err.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleUpdateSandboxBalance = async (targetAmount: number) => {
    if (isNaN(targetAmount) || targetAmount <= 0) {
      showFeedback('error', 'مبلغ بالانس باید بزرگتر از صفر باشد.');
      return;
    }
    setUpdatingBalance(true);
    try {
      const res = await authFetch('/api/ctrader/sandbox/balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ balance: targetAmount }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در تغییر موجودی');
      setStatus(data.status);
      setCustomBalanceInput('');
      showFeedback('success', `موجودی حساب با موفقیت به $${targetAmount.toLocaleString('en-US')} تغییر یافت.`);
    } catch (err: any) {
      showFeedback('error', err.message);
    } finally {
      setUpdatingBalance(false);
    }
  };

  const handleUpdatePrice = async (targetPrice: number) => {
    if (isNaN(targetPrice) || targetPrice <= 0) return;
    setSimulatingPrice(true);
    try {
      const res = await authFetch('/api/ctrader/symbol/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbolId: simSymbolId, price: targetPrice }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در بروزرسانی قیمت');
      setStatus(data.status);
      setSymbols(data.symbols || []);
      setPositions(data.positions || []);
      setPendingOrders(data.pendingOrders || []);
      showFeedback('success', `قیمت به ${targetPrice} بروزرسانی شد و سود/زیان معاملات باز محاسبه گردید.`);
    } catch (err: any) {
      showFeedback('error', err.message);
    } finally {
      setSimulatingPrice(false);
    }
  };

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

  const fetchState = useCallback(async () => {
    try {
      const res = await authFetch('/api/ctrader/state');
      if (!res.ok) {
        if (res.status === 401) return;
        throw new Error('خطا در دریافت وضعیت');
      }
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
  }, [authFetch, symbolId]);

  useEffect(() => {
    if (authUser) {
      fetchState();
    }
  }, [authUser, fetchState]);

  // Periodic Auto-refresh (8s)
  useEffect(() => {
    if (!authUser || !autoRefresh) return;
    const timer = setInterval(() => {
      authFetch('/api/ctrader/state')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && data.status) {
            setStatus(data.status);
            setSymbols(data.symbols || []);
            setPositions(data.positions || []);
            setPendingOrders(data.pendingOrders || []);
          }
        })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(timer);
  }, [authUser, autoRefresh, authFetch]);

  // Listen for OAuth completion
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (origin !== window.location.origin && !origin.endsWith('.run.app') && !origin.includes('localhost')) {
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

  const currentAccount = useMemo(() => {
    if (!status) return null;
    return (
      status.accounts.find((a) => a.ctidTraderAccountId === status.selectedAccountId) ||
      status.activeAccount ||
      status.accounts[0] ||
      null
    );
  }, [status]);

  const currentBalance = currentAccount?.balance ?? (status?.mode === 'sandbox' ? 10000 : 0);
  const currentCurrency = currentAccount?.currency || 'USD';

  // Calculate Unrealized PnL from open positions
  const unrealizedPnL = useMemo(() => {
    let sum = 0;
    for (const p of positions) {
      const sym = symbols.find((s) => s.symbolId === p.symbolId);
      const trade = computeTradePnL(p, sym);
      sum += isNaN(trade.netProfit) ? 0 : trade.netProfit;
    }
    return Math.round(sum * 100) / 100;
  }, [positions, symbols]);

  const equity = Math.max(0, Math.round((currentBalance + unrealizedPnL) * 100) / 100);

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
      const res = await authFetch('/api/ctrader/sync', { method: 'POST' });
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
      const res = await authFetch(`/api/auth/url?redirect_uri=${encodeURIComponent(redirectUri)}`);
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
      const res = await authFetch('/api/ctrader/connect-token', {
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
      const res = await authFetch('/api/ctrader/select-account', {
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

        const res = await authFetch('/api/ctrader/orders/new', {
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
          const res = await authFetch(`/api/ctrader/positions/${selectedEditId}`, {
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
          const res = await authFetch(`/api/ctrader/orders/${selectedEditId}`, {
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
      const res = await authFetch(`/api/ctrader/positions/${posId}/close`, { method: 'POST' });
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
      const res = await authFetch(`/api/ctrader/orders/${ordId}`, { method: 'DELETE' });
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

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
        <div className="flex items-center gap-2.5 text-blue-400">
          <RefreshCw className="w-5 h-5 animate-spin" />
          <span className="text-sm font-medium">در حال بررسی احراز هویت...</span>
        </div>
      </div>
    );
  }

  if (!authUser) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4 font-sans selection:bg-blue-600 selection:text-white">
        <div className="max-w-md w-full bg-slate-900/90 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6 backdrop-blur">
          <div className="text-center space-y-2">
            <div className="w-12 h-12 rounded-xl bg-blue-950/80 border border-blue-800/80 text-blue-400 flex items-center justify-center mx-auto shadow-inner">
              <Lock className="w-6 h-6" />
            </div>
            <h1 className="text-lg font-bold text-white tracking-tight">ورود به میز معاملاتی cTrader</h1>
            <p className="text-xs text-slate-400">
              جهت دسترسی به پنل و مدیریت حساب، نام کاربری و رمز عبور را وارد نمایید.
            </p>
          </div>

          {loginError && (
            <div className="bg-rose-950/70 border border-rose-800/80 text-rose-200 text-xs px-3.5 py-2.5 rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">نام کاربری (Username)</label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  required
                  autoFocus
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  placeholder="مثال: admin"
                  dir="ltr"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg pr-9 pl-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-blue-500 font-mono transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">رمز عبور (Password)</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2" />
                <input
                  type={loginShowPassword ? 'text' : 'password'}
                  required
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="••••••••"
                  dir="ltr"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg pr-9 pl-9 py-2 text-xs text-slate-100 focus:outline-none focus:border-blue-500 font-mono transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setLoginShowPassword(!loginShowPassword)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                >
                  {loginShowPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loginSubmitting}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 shadow-md"
            >
              {loginSubmitting ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>در حال بررسی هویت...</span>
                </>
              ) : (
                <>
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>ورود به سامانه</span>
                </>
              )}
            </button>
          </form>

          {/* Environmental Variable Info Banner */}
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3 text-[11px] text-slate-400 space-y-1.5">
            <div className="flex items-center gap-1.5 text-blue-400 font-semibold">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>احراز هویت با متغیرهای محیطی</span>
            </div>
            <p className="leading-relaxed">
              نام کاربری و رمز عبور از متغیرهای <code className="text-slate-200 font-mono bg-slate-900 px-1 py-0.5 rounded">AUTH_USERNAME</code> و <code className="text-slate-200 font-mono bg-slate-900 px-1 py-0.5 rounded">AUTH_PASSWORD</code> در محیط یا فایل <code className="text-slate-200 font-mono bg-slate-900 px-1 py-0.5 rounded">.env</code> خوانده می‌شوند.
            </p>
            <p className="text-slate-500 text-[10px]">
              پیش‌فرض سیستم: <span className="font-mono text-slate-300">admin</span> / <span className="font-mono text-slate-300">admin123</span>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header - Clean, Production-Grade */}
      <header className="border-b border-slate-800 bg-slate-900/60 sticky top-0 z-20 backdrop-blur px-6 py-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-emerald-400" />
            <span className="font-bold tracking-tight text-white text-base">cTrader Trading Desk</span>
          </div>

          <div className="hidden sm:flex items-center gap-2 text-xs text-slate-400 border-r border-slate-800 pr-4">
            <span>حساب:</span>
            <span className="font-mono text-slate-200">
              #{currentAccount?.ctidTraderAccountId || status?.selectedAccountId || '50091824'}
            </span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${currentAccount?.isLive ?? status?.isLiveEnvironment ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-amber-950 text-amber-400 border border-amber-800'}`}>
              {currentAccount?.isLive ?? status?.isLiveEnvironment ? 'LIVE' : 'DEMO'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Header Balance Pill */}
          <div className="flex items-center gap-2 bg-slate-900/90 border border-slate-800 rounded-lg px-3 py-1.5 shadow-xs">
            <Wallet className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-400 hidden md:inline">بالانس:</span>
              <span className="font-mono font-bold text-xs text-emerald-400 tabular-nums" dir="ltr">
                {currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {currentCurrency}
              </span>
            </div>
          </div>

          {status?.accounts && status.accounts.length > 1 && (
            <select
              value={status.selectedAccountId || ''}
              onChange={(e) => handleAccountSelect(Number(e.target.value))}
              className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none"
            >
              {status.accounts.map((acc) => (
                <option key={acc.ctidTraderAccountId} value={acc.ctidTraderAccountId}>
                  {acc.brokerTitleShort || (acc.isLive ? 'Live' : 'Demo')} (#{acc.ctidTraderAccountId})
                  {acc.balance !== undefined ? ` • ${acc.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })} ${acc.currency || 'USD'}` : ''}
                </option>
              ))}
            </select>
          )}

          {/* Auto Refresh Toggle */}
          <button
            type="button"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded-lg transition-colors ${
              autoRefresh
                ? 'bg-emerald-950/40 border-emerald-800/80 text-emerald-300'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            title={autoRefresh ? 'بروزرسانی خودکار فعال است (هر ۸ ثانیه)' : 'بروزرسانی خودکار غیرفعال'}
          >
            <Activity className={`w-3.5 h-3.5 ${autoRefresh ? 'text-emerald-400 animate-pulse' : ''}`} />
            <span className="hidden md:inline">{autoRefresh ? 'زنده' : 'ثابت'}</span>
          </button>

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

          {/* User Profile & Logout */}
          <div className="flex items-center gap-1.5 pr-2 border-r border-slate-800">
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-900/90 border border-slate-800 rounded-lg text-xs text-slate-300">
              <User className="w-3.5 h-3.5 text-blue-400" />
              <span className="font-mono text-[11px]">{authUser.username}</span>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 border border-rose-900/50 rounded-lg transition-colors"
              title="خروج از حساب کاربری"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">خروج</span>
            </button>
          </div>
        </div>
      </header>

      {/* Account Balance & Metrics Bar */}
      <div className="bg-slate-900/30 border-b border-slate-800/80 px-6 py-3">
        <div className="max-w-[1440px] w-full mx-auto grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* Card 1: Balance */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[11px] text-slate-400 font-medium block">بالانس حساب (Balance)</span>
              <div className="flex items-baseline gap-1 mt-0.5">
                <span className="text-base font-bold font-mono text-white tabular-nums" dir="ltr">
                  {currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="text-[11px] font-mono text-slate-400">{currentCurrency}</span>
              </div>
            </div>
            <div className="w-8 h-8 rounded-lg bg-blue-950/60 border border-blue-800/60 flex items-center justify-center text-blue-400 shrink-0">
              <Wallet className="w-4 h-4" />
            </div>
          </div>

          {/* Card 2: Equity */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[11px] text-slate-400 font-medium block">موجودی شناور (Equity)</span>
              <div className="flex items-baseline gap-1 mt-0.5">
                <span className="text-base font-bold font-mono text-white tabular-nums" dir="ltr">
                  {equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="text-[11px] font-mono text-slate-400">{currentCurrency}</span>
              </div>
            </div>
            <div className="w-8 h-8 rounded-lg bg-indigo-950/60 border border-indigo-800/60 flex items-center justify-center text-indigo-400 shrink-0">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>

          {/* Card 3: Floating PnL */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[11px] text-slate-400 font-medium block">سود / زیان باز (P&L)</span>
              <div className="flex items-baseline gap-1 mt-0.5">
                <span
                  className={`text-base font-bold font-mono tabular-nums ${
                    unrealizedPnL > 0 ? 'text-emerald-400' : unrealizedPnL < 0 ? 'text-rose-400' : 'text-slate-300'
                  }`}
                  dir="ltr"
                >
                  {unrealizedPnL > 0 ? `+${unrealizedPnL.toFixed(2)}` : unrealizedPnL.toFixed(2)}
                </span>
                <span className="text-[11px] font-mono text-slate-400">{currentCurrency}</span>
              </div>
            </div>
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
                unrealizedPnL > 0
                  ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-400'
                  : unrealizedPnL < 0
                  ? 'bg-rose-950/60 border-rose-800/60 text-rose-400'
                  : 'bg-slate-900 border-slate-800 text-slate-400'
              }`}
            >
              {unrealizedPnL >= 0 ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
            </div>
          </div>

          {/* Card 4: Account details */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[11px] text-slate-400 font-medium block">مشخصات حساب</span>
              <div className="flex items-center gap-1.5 mt-1 text-xs">
                <span className="font-mono text-slate-300">#{currentAccount?.ctidTraderAccountId || '50091824'}</span>
                <span className="text-slate-600">•</span>
                <span className="font-mono text-slate-400">1:{currentAccount?.leverage || 100}</span>
                <span
                  className={`px-1 py-0.2 rounded text-[9px] font-bold ${
                    currentAccount?.isLive
                      ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                      : 'bg-amber-950 text-amber-400 border border-amber-800'
                  }`}
                >
                  {currentAccount?.isLive ? 'LIVE' : 'DEMO'}
                </span>
              </div>
            </div>
            <div className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 shrink-0">
              <Layers className="w-4 h-4" />
            </div>
          </div>
        </div>
      </div>

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

      {/* Setup Guide Banner when credentials are empty */}
      {status && (!status.hasClientId || !status.hasClientSecret) && (
        <div className="bg-blue-950/40 border-b border-blue-900/60 px-6 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-blue-200">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-blue-400 shrink-0" />
            <span>
              <strong>راهنمای اتصال:</strong> نیازی به تعریف متغیر در کولیفای نیست! مشخصات cTrader خود را می‌توانید مستقیماً از بخش «تنظیمات حساب» ذخیره کنید.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowSettingsModal(true)}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium text-xs transition-colors shrink-0"
          >
            ورود اطلاعات و اتصال
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
              <button
                type="button"
                onClick={() => {
                  setShowPriceSimulator(!showPriceSimulator);
                  setSimSymbolId(symbolId);
                  const sym = symbols.find((s) => s.symbolId === symbolId);
                  if (sym) setSimPriceInput(sym.referencePrice.toString());
                }}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs border rounded-lg transition-colors cursor-pointer ${
                  showPriceSimulator
                    ? 'bg-blue-950/70 border-blue-700 text-blue-300'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                }`}
                title="شبیه‌سازی تغییر قیمت نماد و بررسی تغییرات سود و زیان"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-blue-400" />
                <span className="hidden sm:inline">شبیه‌سازی قیمت</span>
              </button>

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

          {/* Quick Price Simulation Panel (For testing PnL in sandbox & live) */}
          {showPriceSimulator && (
            <div className="bg-slate-950/90 border border-blue-900/60 rounded-xl p-3 text-xs space-y-2.5 animate-in fade-in duration-150">
              <div className="flex items-center justify-between pb-1.5 border-b border-slate-900">
                <div className="flex items-center gap-1.5 text-blue-300 font-semibold">
                  <SlidersHorizontal className="w-3.5 h-3.5 text-blue-400" />
                  <span>شبیه‌ساز قیمت نماد (تست تغییر سود و ضرر پوزیشن‌ها)</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPriceSimulator(false)}
                  className="text-slate-500 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={simSymbolId}
                  onChange={(e) => {
                    const sid = Number(e.target.value);
                    setSimSymbolId(sid);
                    const s = symbols.find((item) => item.symbolId === sid);
                    if (s) setSimPriceInput(s.referencePrice.toString());
                  }}
                  className="bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none"
                >
                  {symbols.map((s) => (
                    <option key={s.symbolId} value={s.symbolId}>
                      {s.symbolName} (قیمت: {s.referencePrice})
                    </option>
                  ))}
                </select>

                <input
                  type="number"
                  step="any"
                  value={simPriceInput}
                  onChange={(e) => setSimPriceInput(e.target.value)}
                  placeholder="قیمت جدید"
                  dir="ltr"
                  className="w-32 bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-xs font-mono text-white focus:outline-none focus:border-blue-500"
                />

                <button
                  type="button"
                  onClick={() => {
                    const val = parseFloat(simPriceInput);
                    if (!isNaN(val) && val > 0) handleUpdatePrice(val);
                  }}
                  disabled={simulatingPrice || !simPriceInput}
                  className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded text-xs font-semibold transition-colors cursor-pointer"
                >
                  {simulatingPrice ? '...' : 'اعمال قیمت'}
                </button>

                <div className="flex items-center gap-1 pr-2 border-r border-slate-800">
                  <span className="text-[10px] text-slate-500">نوسان:</span>
                  {[-10, -5, +5, +10].map((deltaPips) => {
                    const currentSym = symbols.find((s) => s.symbolId === simSymbolId);
                    const pipSize = currentSym?.pipPosition !== undefined ? Math.pow(10, -currentSym.pipPosition) : 0.0001;
                    const target = currentSym ? Number((currentSym.referencePrice + deltaPips * pipSize).toFixed(currentSym.digits)) : 0;
                    return (
                      <button
                        key={deltaPips}
                        type="button"
                        onClick={() => {
                          setSimPriceInput(target.toString());
                          handleUpdatePrice(target);
                        }}
                        disabled={simulatingPrice || !currentSym}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                          deltaPips > 0
                            ? 'bg-emerald-950 hover:bg-emerald-900 text-emerald-400 border border-emerald-800/60'
                            : 'bg-rose-950 hover:bg-rose-900 text-rose-400 border border-rose-800/60'
                        }`}
                      >
                        {deltaPips > 0 ? `+${deltaPips}p` : `${deltaPips}p`}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

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
                        <th className="py-2 px-2.5">قیمت ورود</th>
                        <th className="py-2 px-2.5">قیمت لحظه‌ای</th>
                        <th className="py-2 px-2.5">سود / زیان (P&L)</th>
                        <th className="py-2 px-2.5">حد ضرر</th>
                        <th className="py-2 px-2.5">حد سود</th>
                        <th className="py-2 px-2.5 text-left">عملیات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/40">
                      {filteredPositions.map((p) => {
                        const sym = symbols.find((s) => s.symbolId === p.symbolId);
                        const trade = computeTradePnL(p, sym);
                        const isProfit = trade.netProfit > 0;
                        const isLoss = trade.netProfit < 0;
                        const digits = sym?.digits ?? 2;

                        return (
                          <tr
                            key={p.positionId}
                            className={`hover:bg-slate-800/30 transition-colors ${
                              selectedEditId === p.positionId && formMode === 'edit' ? 'bg-blue-950/20' : ''
                            }`}
                          >
                            <td className="py-2.5 px-2.5">
                              <span className="font-bold text-white text-xs">{p.symbolName}</span>
                              <span className="block text-[10px] text-slate-500 font-mono">#{p.positionId}</span>
                            </td>
                            <td className="py-2.5 px-2.5 font-mono">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  p.tradeSide === 'BUY'
                                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                                    : 'bg-rose-950 text-rose-400 border border-rose-800/60'
                                }`}
                              >
                                {p.tradeSide}
                              </span>
                              <span className="text-slate-300 font-medium mr-1.5 text-xs">{p.volumeLots.toFixed(2)} Lot</span>
                            </td>
                            <td className="py-2.5 px-2.5 font-mono text-slate-200 text-xs" dir="ltr">
                              {p.entryPrice.toFixed(digits)}
                            </td>
                            <td className="py-2.5 px-2.5 font-mono text-xs" dir="ltr">
                              <span className="text-slate-100 font-bold">{trade.currentPrice.toFixed(digits)}</span>
                            </td>
                            <td className="py-2.5 px-2.5">
                              <div className="flex flex-col items-start gap-0.5">
                                <div className="flex items-center gap-1.5 font-mono">
                                  <span
                                    className={`font-bold text-xs tabular-nums ${
                                      isProfit
                                        ? 'text-emerald-400'
                                        : isLoss
                                        ? 'text-rose-400'
                                        : 'text-slate-300'
                                    }`}
                                    dir="ltr"
                                  >
                                    {isProfit ? `+${trade.netProfit.toFixed(2)}` : trade.netProfit.toFixed(2)} {currentCurrency}
                                  </span>
                                  <span
                                    className={`px-1 py-0.2 rounded text-[10px] font-mono font-semibold ${
                                      isProfit
                                        ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/80'
                                        : isLoss
                                        ? 'bg-rose-950/80 text-rose-400 border border-rose-800/80'
                                        : 'bg-slate-900 text-slate-400'
                                    }`}
                                    dir="ltr"
                                  >
                                    {trade.pips > 0 ? `+${trade.pips}` : trade.pips} pip
                                  </span>
                                </div>
                                <div className="flex items-center gap-1 text-[10px] text-slate-500 font-mono">
                                  <span>{trade.pct > 0 ? `+${trade.pct}%` : `${trade.pct}%`}</span>
                                  {(p.commission !== 0 || p.swap !== 0) && (
                                    <>
                                      <span>•</span>
                                      <span>ک: {p.commission.toFixed(2)}</span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="py-2.5 px-2.5 font-mono text-rose-400 text-xs" dir="ltr">
                              {p.stopLoss !== null ? p.stopLoss.toFixed(digits) : '—'}
                            </td>
                            <td className="py-2.5 px-2.5 font-mono text-emerald-400 text-xs" dir="ltr">
                              {p.takeProfit !== null ? p.takeProfit.toFixed(digits) : '—'}
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
                        );
                      })}
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

            {/* Dynamic Credentials Form */}
            <form onSubmit={handleSaveCredentials} className="bg-slate-950 border border-slate-800 p-4 rounded-lg space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-slate-900">
                <h4 className="text-xs font-bold text-white">تنظیم مستقیم کلیدهای cTrader</h4>
                <span className="text-[10px] text-slate-500">ذخیره خودکار روی سرور بدون نیاز به کولیفای</span>
              </div>

              <div className="space-y-2">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Client ID</label>
                  <input
                    type="text"
                    value={inputClientId}
                    onChange={(e) => setInputClientId(e.target.value)}
                    placeholder={status?.clientIdMasked ? `فعلی: ${status.clientIdMasked}` : 'Client ID از پنل cTrader'}
                    dir="ltr"
                    className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Client Secret</label>
                  <input
                    type="password"
                    value={inputClientSecret}
                    onChange={(e) => setInputClientSecret(e.target.value)}
                    placeholder={status?.hasClientSecret ? '•••••••••••••••• (تنظیم شده)' : 'Client Secret از پنل cTrader'}
                    dir="ltr"
                    className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Access Token (اختیاری جهت اتصال فوری بدون OAuth)</label>
                  <input
                    type="password"
                    value={manualToken}
                    onChange={(e) => setManualToken(e.target.value)}
                    placeholder={status?.hasAccessToken ? '•••••••••••••••• (توکن فعال است)' : 'Access Token پروداکشن'}
                    dir="ltr"
                    className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={syncing}
                className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs rounded transition-colors disabled:opacity-50"
              >
                ذخیره اطلاعات و اتصال
              </button>
            </form>

            {/* Connected Accounts & Balances Overview */}
            {status?.accounts && status.accounts.length > 0 && (
              <div className="bg-slate-950 border border-slate-800 p-4 rounded-lg space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-slate-900">
                  <div className="flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-emerald-400" />
                    <h4 className="text-xs font-bold text-white">حساب‌های متصل و بالانس (Balances)</h4>
                  </div>
                  <span className="text-[10px] text-slate-400">
                    {status.accounts.length} حساب شناسایی شد
                  </span>
                </div>

                <div className="space-y-2 max-h-48 overflow-y-auto pr-0.5">
                  {status.accounts.map((acc) => {
                    const isActive = acc.ctidTraderAccountId === (status.selectedAccountId || 50091824);
                    const bal = acc.balance !== undefined ? acc.balance : (status.mode === 'sandbox' ? 10000 : 0);
                    const curr = acc.currency || 'USD';

                    return (
                      <div
                        key={acc.ctidTraderAccountId}
                        className={`p-2.5 rounded-lg border flex items-center justify-between transition-colors ${
                          isActive
                            ? 'bg-blue-950/30 border-blue-800/80'
                            : 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-800/40'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-emerald-400 ring-2 ring-emerald-950' : 'bg-slate-600'}`} />
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-xs text-white">
                                {acc.brokerTitleShort || (acc.isLive ? 'cTrader Live' : 'cTrader Demo')}
                              </span>
                              <span
                                className={`px-1 py-0.2 rounded text-[9px] font-bold ${
                                  acc.isLive
                                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                                    : 'bg-amber-950 text-amber-400 border border-amber-800'
                                }`}
                              >
                                {acc.isLive ? 'LIVE' : 'DEMO'}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-[11px] font-mono text-slate-400">
                              <span>#{acc.ctidTraderAccountId}</span>
                              {acc.leverage && (
                                <>
                                  <span className="text-slate-600">•</span>
                                  <span>1:{acc.leverage}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-3">
                          <div className="text-left font-mono">
                            <span className="text-[10px] text-slate-400 block">بالانس</span>
                            <span className="text-xs font-bold text-emerald-400 tabular-nums" dir="ltr">
                              {bal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {curr}
                            </span>
                          </div>

                          {!isActive ? (
                            <button
                              type="button"
                              onClick={() => handleAccountSelect(acc.ctidTraderAccountId)}
                              disabled={syncing}
                              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-[11px] font-medium transition-colors"
                            >
                              انتخاب
                            </button>
                          ) : (
                            <span className="px-2 py-0.5 bg-blue-950 text-blue-300 border border-blue-800/60 rounded text-[10px] font-semibold">
                              فعال
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Sandbox Demo Balance Customizer */}
                {status.mode === 'sandbox' && (
                  <div className="pt-2 border-t border-slate-900 mt-2 space-y-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-300 font-medium flex items-center gap-1">
                        <Coins className="w-3.5 h-3.5 text-amber-400" />
                        <span>تنظیم بالانس حساب تستی (Sandbox)</span>
                      </span>
                      <span className="font-mono text-slate-500">فعلی: ${currentBalance.toLocaleString('en-US')}</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="1"
                        step="100"
                        placeholder="مبلغ مورد نظر (مثلاً 50000)"
                        value={customBalanceInput}
                        onChange={(e) => setCustomBalanceInput(e.target.value)}
                        dir="ltr"
                        className="flex-1 bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const val = parseFloat(customBalanceInput);
                          if (!isNaN(val) && val > 0) handleUpdateSandboxBalance(val);
                        }}
                        disabled={updatingBalance || !customBalanceInput}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded text-xs font-semibold transition-colors"
                      >
                        {updatingBalance ? '...' : 'تغییر بالانس'}
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span className="text-slate-500">پیش‌فرض‌ها:</span>
                      {[5000, 10000, 25000, 50000, 100000].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => handleUpdateSandboxBalance(preset)}
                          disabled={updatingBalance}
                          className="px-1.5 py-0.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded font-mono text-slate-300 transition-colors"
                        >
                          ${(preset / 1000).toFixed(0)}k
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Direct OAuth Section */}
            <div className="bg-slate-950 border border-slate-800 p-4 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-white">یا ورود خودکار با cTrader OAuth</h4>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    پس از ذخیره Client ID و Secret، مستقیماً لاگین کنید
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleConnectOAuth}
                  disabled={!status?.hasClientId}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded text-xs font-semibold transition-colors flex items-center gap-1.5 disabled:opacity-40"
                >
                  <span>ورود با cTrader</span>
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
          </div>
        </div>
      )}
    </div>
  );
}
