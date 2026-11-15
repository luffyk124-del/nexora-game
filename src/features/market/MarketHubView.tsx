import {
  ArrowDownLeft,
  ArrowUpRight,
  FileCheck2,
  Search,
  Send,
  ShoppingBag,
  Tag,
} from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/ToastProvider';
import { BRAND_ASSETS, CATALOG_ITEMS, ITEM_MAP, TRADE_CONTRACTS } from '../../data/catalog';
import { useTranslations } from '../../i18n/translations';
import { calculateDynamicItemPrice, calculateMarketTaxRate } from '../../lib/economy';
import {
  buyMarketListing,
  cancelMarketListing,
  createMarketListing,
  fulfillTradeContract,
  getUtcDateKey,
  transferCredits,
} from '../../services/gameService';
import type {
  InventoryItem,
  ItemTier,
  Language,
  MarketListing,
  MarketSubTab,
  PlayerProfile,
  TransactionRecord,
  Wallet,
  WorldEvent,
} from '../../types/game';

interface MarketHubViewProps {
  profile: PlayerProfile;
  wallet: Wallet | null;
  inventory: InventoryItem[];
  marketListings: MarketListing[];
  transactions: TransactionRecord[];
  worldEvents: WorldEvent[];
  claimedContractsToday: Set<string>;
  language: Language;
}

export function MarketHubView({
  profile,
  wallet,
  inventory,
  marketListings,
  transactions,
  worldEvents,
  claimedContractsToday,
  language,
}: MarketHubViewProps) {
  const t = useTranslations(language);
  const { showToast } = useToast();

  const [subTab, setSubTab] = useState<MarketSubTab>('exchange');
  const [searchQuery, setSearchQuery] = useState('');
  const [tierFilter, setTierFilter] = useState<'all' | ItemTier>('all');
  const [buyQuantities, setBuyQuantities] = useState<Record<string, number>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Create Sell Listing form
  const ownedStacks = inventory.filter((i) => i.quantity > 0);
  const [sellItemId, setSellItemId] = useState(ownedStacks[0]?.itemId || 'silicon_ore');
  const [sellQty, setSellQty] = useState(1);
  const [sellPrice, setSellPrice] = useState(40);

  // Bank Transfer form
  const [recipientName, setRecipientName] = useState('');
  const [transferAmount, setTransferAmount] = useState(100);
  const [transferNote, setTransferNote] = useState('');
  const [confirmTransferOpen, setConfirmTransferOpen] = useState(false);

  const taxRate = calculateMarketTaxRate(profile.skills.trade || 0, worldEvents);
  const invMap = new Map<string, number>();
  inventory.forEach((i) => invMap.set(i.itemId, i.quantity));
  const todayKey = getUtcDateKey();

  const filteredListings = marketListings.filter((l) => {
    const item = ITEM_MAP[l.itemId];
    if (!item || l.status !== 'active' || l.remainingQty <= 0) return false;
    if (tierFilter !== 'all' && item.tier !== tierFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return (
        item.nameAr.toLowerCase().includes(q) ||
        item.nameEn.toLowerCase().includes(q) ||
        l.sellerName.toLowerCase().includes(q)
      );
    }
    return true;
  });

  async function handleBuy(listing: MarketListing) {
    const qty = Math.min(listing.remainingQty, Math.max(1, buyQuantities[listing.id] || 1));
    setBusyKey(`buy_${listing.id}`);
    try {
      await buyMarketListing(profile.uid, listing.id, qty, taxRate);
      showToast(
        language === 'ar'
          ? `تم شراء ${qty} وحدة بنجاح.`
          : `Purchased ${qty} units successfully.`,
        'success'
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'INSUFFICIENT_FUNDS'
          ? language === 'ar'
            ? 'رصيدك غير كافٍ.'
            : 'Insufficient balance.'
          : code === 'CANNOT_BUY_OWN_LISTING'
          ? language === 'ar'
            ? 'لا يمكنك شراء عرضك الخاص.'
            : 'You cannot purchase your own listing.'
          : language === 'ar'
          ? 'تعذر إتمام الشراء.'
          : 'Purchase failed.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCreateListing(e: React.FormEvent) {
    e.preventDefault();
    setBusyKey('sell_create');
    try {
      await createMarketListing(profile.uid, profile.username, sellItemId, sellQty, sellPrice);
      showToast(
        language === 'ar' ? 'تم نشر عرض البيع في السوق.' : 'Sell offer published on market.',
        'success'
      );
    } catch {
      showToast(
        language === 'ar'
          ? 'تأكد من توفر الكمية في مخزونك.'
          : 'Verify you have enough inventory to list.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCancelListing(listingId: string) {
    setBusyKey(`can_${listingId}`);
    try {
      await cancelMarketListing(profile.uid, listingId);
      showToast(
        language === 'ar' ? 'تم إلغاء العرض وإعادة الكمية للمخزون.' : 'Listing cancelled and stock returned.',
        'info'
      );
    } catch {
      showToast(language === 'ar' ? 'تعذر إلغاء العرض.' : 'Could not cancel listing.', 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleFulfillContract(contractId: string) {
    setBusyKey(`ctr_${contractId}`);
    try {
      const payout = await fulfillTradeContract(profile.uid, contractId);
      showToast(
        language === 'ar'
          ? `تم تنفيذ العقد واستلام +${payout} N-Credits.`
          : `Contract fulfilled: +${payout} N-Credits.`,
        'success'
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'MISSING_INPUTS'
          ? language === 'ar'
            ? 'المنتج المطلوب غير متوفر في المخزون.'
            : 'Required product missing from inventory.'
          : language === 'ar'
          ? 'تم تنفيذ هذا العقد اليوم بالفعل.'
          : 'Contract already fulfilled today.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function executeTransfer() {
    setBusyKey('transfer');
    try {
      await transferCredits(profile.uid, recipientName, transferAmount, transferNote);
      setConfirmTransferOpen(false);
      setRecipientName('');
      setTransferNote('');
      showToast(
        language === 'ar' ? 'تم تنفيذ التحويل المالي بنجاح.' : 'Transfer completed.',
        'success'
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'RECIPIENT_NOT_FOUND'
          ? language === 'ar'
            ? 'اسم المستخدم غير موجود.'
            : 'Recipient username not found.'
          : code === 'INSUFFICIENT_FUNDS'
          ? language === 'ar'
            ? 'الرصيد غير كافٍ.'
            : 'Insufficient funds.'
          : language === 'ar'
          ? 'بيانات التحويل غير صالحة.'
          : 'Invalid transfer details.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  const subTabs: { id: MarketSubTab; label: string }[] = [
    { id: 'exchange', label: t.subExchange },
    { id: 'contracts', label: t.subContracts },
    { id: 'bank', label: t.subBank },
    { id: 'ledger', label: t.subLedger },
  ];

  return (
    <div className="space-y-5">
      {/* Sub-navigation */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {subTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setSubTab(tab.id)}
            className={`min-h-[40px] px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
              subTab === tab.id
                ? 'bg-[#B91C32] text-white'
                : 'bg-[#141821] text-[#9299A6] border border-white/8 hover:text-[#F4F5F7]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 1. OPEN EXCHANGE */}
      {subTab === 'exchange' && (
        <div className="space-y-5">
          {/* Market Banner Card */}
          <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#141821]">
            <img
              src={BRAND_ASSETS.marketBanner}
              alt="NEXORA Global Exchange"
              referrerPolicy="no-referrer"
              className="w-full h-36 sm:h-44 object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#0B0D12] via-[#0B0D12]/55 to-transparent flex items-end p-5">
              <div className="w-full flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h1 className="text-lg font-bold text-[#F4F5F7]">
                    {language === 'ar' ? 'سوق NEXORA المفتوح' : 'NEXORA Open Exchange'}
                  </h1>
                  <p className="text-xs text-[#9299A6] mt-0.5">
                    {t.marketTax}:{' '}
                    <span className="font-mono-num text-[#F4F5F7]">
                      {(taxRate * 100).toFixed(1)}%
                    </span>{' '}
                    ·{' '}
                    <span className="font-mono-num text-[#F4F5F7]">
                      {marketListings.length}
                    </span>{' '}
                    {language === 'ar' ? 'عروض نشطة' : 'active offers'}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Post Sell Listing Form */}
            <form
              onSubmit={handleCreateListing}
              className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-4 h-fit"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-[#F4F5F7]">{t.createListing}</h2>
                <Tag className="w-4 h-4 text-[#E04455]" />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-[#9299A6]">
                  {language === 'ar' ? 'العنصر من المخزون' : 'Item from Inventory'}
                </label>
                <select
                  value={sellItemId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSellItemId(id);
                    const base = ITEM_MAP[id]?.basePrice || 40;
                    setSellPrice(base);
                  }}
                  className="w-full min-h-[44px] px-3 rounded-xl bg-[#0B0D12] border border-white/10 text-sm text-[#F4F5F7] focus:outline-none focus:border-[#E04455]"
                >
                  {CATALOG_ITEMS.map((item) => {
                    const owned = invMap.get(item.id) || 0;
                    return (
                      <option key={item.id} value={item.id}>
                        {language === 'ar' ? item.nameAr : item.nameEn} ({owned})
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-[#9299A6]">{t.quantity}</label>
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, invMap.get(sellItemId) || 1)}
                    value={sellQty}
                    onChange={(e) => setSellQty(Math.max(1, Number(e.target.value)))}
                    className="w-full min-h-[44px] px-3 rounded-xl bg-[#0B0D12] border border-white/10 text-sm font-mono-num text-[#F4F5F7] focus:outline-none focus:border-[#E04455]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-[#9299A6]">{t.unitPrice}</label>
                  <input
                    type="number"
                    min={1}
                    value={sellPrice}
                    onChange={(e) => setSellPrice(Math.max(1, Number(e.target.value)))}
                    className="w-full min-h-[44px] px-3 rounded-xl bg-[#0B0D12] border border-white/10 text-sm font-mono-num text-[#F4F5F7] focus:outline-none focus:border-[#E04455]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busyKey === 'sell_create' || (invMap.get(sellItemId) || 0) < sellQty}
                className="w-full min-h-[44px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-sm font-semibold transition-colors disabled:bg-[#1B2230] disabled:text-[#9299A6]"
              >
                {busyKey === 'sell_create' ? '...' : t.createListing}
              </button>
            </form>

            {/* Market Orderbook */}
            <div className="lg:col-span-2 space-y-3.5">
              {/* Search & Tier Filter */}
              <div className="flex flex-col sm:flex-row gap-2.5">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-[#9299A6] absolute top-1/2 -translate-y-1/2 start-3.5" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t.searchPlaceholder}
                    className="w-full min-h-[42px] ps-10 pe-3.5 rounded-xl bg-[#141821] border border-white/8 text-sm text-[#F4F5F7] placeholder:text-[#9299A6]/70 focus:outline-none focus:border-[#E04455]"
                  />
                </div>
                <div className="flex items-center gap-1 bg-[#141821] border border-white/8 rounded-xl p-1">
                  {(['all', 'raw', 'intermediate', 'final'] as const).map((tier) => (
                    <button
                      key={tier}
                      type="button"
                      onClick={() => setTierFilter(tier)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                        tierFilter === tier
                          ? 'bg-[#1B2230] text-[#F4F5F7]'
                          : 'text-[#9299A6] hover:text-[#F4F5F7]'
                      }`}
                    >
                      {tier === 'all'
                        ? t.allTiers
                        : tier === 'raw'
                        ? t.tierRaw
                        : tier === 'intermediate'
                        ? t.tierIntermediate
                        : t.tierFinal}
                    </button>
                  ))}
                </div>
              </div>

              {/* Listings */}
              {filteredListings.length === 0 ? (
                <div className="bg-[#141821] border border-white/8 rounded-2xl p-8 text-center">
                  <p className="text-sm text-[#9299A6]">
                    {language === 'ar'
                      ? 'لا توجد عروض مطابقة للبحث حالياً.'
                      : 'No active listings match your current filters.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredListings.map((listing) => {
                    const item = ITEM_MAP[listing.itemId];
                    if (!item) return null;
                    const isMine = listing.sellerUid === profile.uid;
                    const selectedQty = buyQuantities[listing.id] || 1;
                    const refPrice = calculateDynamicItemPrice(
                      listing.itemId,
                      listing.remainingQty,
                      worldEvents
                    );

                    return (
                      <div
                        key={listing.id}
                        className="bg-[#141821] border border-white/8 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <ShoppingBag className="w-4 h-4 text-[#E04455] shrink-0" />
                            <h3 className="text-sm font-bold text-[#F4F5F7]">
                              {language === 'ar' ? item.nameAr : item.nameEn}
                            </h3>
                          </div>
                          <p className="text-xs text-[#9299A6]">
                            {listing.sellerName} ·{' '}
                            <span className="font-mono-num text-[#F4F5F7]">
                              {listing.remainingQty}
                            </span>{' '}
                            {language === 'ar' ? 'متاح' : 'avail'} ·{' '}
                            {language === 'ar' ? 'السعر المرجعي:' : 'Index:'}{' '}
                            <span className="font-mono-num">{refPrice}</span>
                          </p>
                        </div>

                        <div className="flex items-center gap-2.5 shrink-0">
                          <div className="text-end me-1">
                            <p className="text-sm font-mono-num font-bold text-[#F4F5F7]">
                              {listing.unitPrice.toLocaleString()}
                            </p>
                            <p className="text-[11px] text-[#9299A6]">/ {t.currency}</p>
                          </div>

                          {isMine ? (
                            <button
                              type="button"
                              disabled={busyKey === `can_${listing.id}`}
                              onClick={() => handleCancelListing(listing.id)}
                              className="min-h-[40px] px-3.5 rounded-xl bg-[#1B2230] hover:bg-[#232C3E] text-[#F4F5F7] text-xs font-semibold whitespace-nowrap"
                            >
                              {t.cancelListing}
                            </button>
                          ) : (
                            <>
                              <input
                                type="number"
                                min={1}
                                max={listing.remainingQty}
                                value={selectedQty}
                                onChange={(e) =>
                                  setBuyQuantities((prev) => ({
                                    ...prev,
                                    [listing.id]: Math.min(
                                      listing.remainingQty,
                                      Math.max(1, Number(e.target.value))
                                    ),
                                  }))
                                }
                                aria-label={t.quantity}
                                className="w-16 min-h-[40px] px-2 rounded-xl bg-[#0B0D12] border border-white/10 text-center text-xs font-mono-num text-[#F4F5F7]"
                              />
                              <button
                                type="button"
                                disabled={
                                  busyKey === `buy_${listing.id}` ||
                                  (wallet?.balance ?? 0) < listing.unitPrice * selectedQty
                                }
                                onClick={() => handleBuy(listing)}
                                className="min-h-[40px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-xs font-semibold whitespace-nowrap disabled:bg-[#1B2230] disabled:text-[#9299A6]"
                              >
                                {busyKey === `buy_${listing.id}`
                                  ? '...'
                                  : `${t.buyNow} (${(
                                      listing.unitPrice * selectedQty
                                    ).toLocaleString()})`}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. TRADE CONTRACTS */}
      {subTab === 'contracts' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {TRADE_CONTRACTS.map((ctr) => {
            const item = ITEM_MAP[ctr.requiredItemId];
            const owned = invMap.get(ctr.requiredItemId) || 0;
            const claimed = claimedContractsToday.has(`${ctr.id}_${todayKey}`);
            const payout = Math.min(
              2500,
              Math.round(ctr.payoutCredits * (1 + (profile.skills.negotiation || 0) * 0.07))
            );

            return (
              <div
                key={ctr.id}
                className="bg-[#141821] border border-white/8 rounded-2xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-bold text-[#F4F5F7]">
                      {language === 'ar' ? ctr.titleAr : ctr.titleEn}
                    </h3>
                    <FileCheck2 className="w-4 h-4 text-[#E04455] shrink-0" />
                  </div>
                  <p className="text-xs text-[#9299A6]">
                    {language === 'ar' ? ctr.clientAr : ctr.clientEn}
                  </p>
                </div>

                <div className="bg-[#0B0D12] border border-white/6 rounded-xl p-3.5 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-[#9299A6]">
                      {language === 'ar' ? item.nameAr : item.nameEn}
                    </span>
                    <span
                      className={`font-mono-num font-semibold ${
                        owned >= ctr.requiredQty ? 'text-emerald-400' : 'text-[#E04455]'
                      }`}
                    >
                      {owned} / {ctr.requiredQty}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#9299A6]">{language === 'ar' ? 'العائد' : 'Payout'}</span>
                    <span className="font-mono-num font-bold text-emerald-400">
                      +{payout.toLocaleString()} {t.currency}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={claimed || owned < ctr.requiredQty || busyKey === `ctr_${ctr.id}`}
                  onClick={() => handleFulfillContract(ctr.id)}
                  className="w-full min-h-[44px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-xs font-semibold transition-colors disabled:bg-[#1B2230] disabled:text-[#9299A6]"
                >
                  {claimed ? t.claimed : busyKey === `ctr_${ctr.id}` ? '...' : t.executeContract}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* 3. BANK & TRANSFERS */}
      {subTab === 'bank' && (
        <div className="max-w-lg bg-[#141821] border border-white/8 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-[#F4F5F7]">{t.transferTitle}</h2>
            <Send className="w-4 h-4 text-[#E04455]" />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-[#9299A6]">{t.recipientUsername}</label>
            <input
              type="text"
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
              dir="ltr"
              placeholder="Username"
              className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#0B0D12] border border-white/10 text-sm text-[#F4F5F7] focus:outline-none focus:border-[#E04455]"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-[#9299A6]">{t.transferAmount}</label>
            <input
              type="number"
              min={1}
              max={wallet?.balance ?? 0}
              value={transferAmount}
              onChange={(e) => setTransferAmount(Math.max(1, Number(e.target.value)))}
              className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#0B0D12] border border-white/10 text-sm font-mono-num text-[#F4F5F7] focus:outline-none focus:border-[#E04455]"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-[#9299A6]">
              {language === 'ar' ? 'مرجع العملية (اختياري)' : 'Reference Note (Optional)'}
            </label>
            <input
              type="text"
              value={transferNote}
              onChange={(e) => setTransferNote(e.target.value)}
              maxLength={120}
              className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#0B0D12] border border-white/10 text-sm text-[#F4F5F7] focus:outline-none focus:border-[#E04455]"
            />
          </div>

          <button
            type="button"
            disabled={!recipientName.trim() || transferAmount <= 0 || transferAmount > (wallet?.balance ?? 0)}
            onClick={() => setConfirmTransferOpen(true)}
            className="w-full min-h-[46px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-sm font-semibold transition-colors disabled:bg-[#1B2230] disabled:text-[#9299A6]"
          >
            {t.sendTransfer}
          </button>
        </div>
      )}

      {/* 4. TRANSACTION LEDGER */}
      {subTab === 'ledger' && (
        <div className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-3">
          <h2 className="text-base font-semibold text-[#F4F5F7]">{t.subLedger}</h2>
          {transactions.length === 0 ? (
            <p className="text-sm text-[#9299A6] py-8 text-center">{t.noActivity}</p>
          ) : (
            <div className="space-y-2">
              {transactions.map((tx) => {
                const isCredit = tx.toUid === profile.uid;
                return (
                  <div
                    key={tx.id}
                    className="p-3.5 rounded-xl bg-[#0B0D12] border border-white/6 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-[#1B2230] flex items-center justify-center shrink-0">
                        {isCredit ? (
                          <ArrowDownLeft className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <ArrowUpRight className="w-4 h-4 text-[#E04455]" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[#F4F5F7] truncate">
                          {tx.description}
                        </p>
                        <p className="text-[11px] text-[#9299A6] font-mono-num mt-0.5">
                          {tx.id} · {tx.type}
                        </p>
                      </div>
                    </div>
                    <div className="text-end shrink-0">
                      <p
                        className={`text-sm font-mono-num font-bold ${
                          isCredit ? 'text-emerald-400' : 'text-[#F4F5F7]'
                        }`}
                      >
                        {isCredit
                          ? `+${tx.netAmount.toLocaleString()}`
                          : `-${tx.amount.toLocaleString()}`}
                      </p>
                      {tx.fee > 0 && (
                        <p className="text-[10px] font-mono-num text-[#9299A6]">
                          Fee: {tx.fee}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmTransferOpen}
        title={t.confirmTitle}
        description={
          language === 'ar'
            ? `سيتم تحويل ${transferAmount.toLocaleString()} N-Credits بشكل فوري وغير قابل للاسترجاع إلى ${recipientName}.`
            : `Transfer ${transferAmount.toLocaleString()} N-Credits immediately to ${recipientName}?`
        }
        confirmLabel={t.confirmBtn}
        cancelLabel={t.cancelBtn}
        busy={busyKey === 'transfer'}
        onConfirm={executeTransfer}
        onCancel={() => setConfirmTransferOpen(false)}
      />
    </div>
  );
}
