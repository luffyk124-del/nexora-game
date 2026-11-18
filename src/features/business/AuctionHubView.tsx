import { useEffect, useState } from 'react';
import { Clock3, Gavel } from 'lucide-react';
import { useToast } from '../../components/ui/ToastProvider';
import { createCompanyAuction, placeCompanyAuctionBid } from '../../services/gameService';
import type { Company, CompanyAuction, Language, PlayerProfile, Wallet } from '../../types/game';

interface AuctionHubViewProps {
  companies: Company[];
  auctions: CompanyAuction[];
  profile: PlayerProfile;
  wallet: Wallet | null;
  language: Language;
}

export function AuctionHubView({ companies, auctions, profile, wallet, language }: AuctionHubViewProps) {
  const ar = language === 'ar';
  const { showToast } = useToast();
  const [now, setNow] = useState(Date.now());
  const [expandedCompany, setExpandedCompany] = useState<string | null>(null);
  const [startPrices, setStartPrices] = useState<Record<string, string>>({});
  const [bidInputs, setBidInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const formatTime = (ms: number) => {
    const total = Math.ceil(Math.max(0, ms) / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return days > 0
      ? days + 'd ' + hours + 'h'
      : hours.toString().padStart(2, '0') + ':' + minutes.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');
  };

  async function createAuction(company: Company) {
    const startingPrice = Number(startPrices[company.id] ?? company.level * 1000);
    if (!Number.isSafeInteger(startingPrice) || startingPrice < 0) {
      showToast(ar ? 'أدخل سعراً صحيحاً.' : 'Enter a valid starting price.', 'error');
      return;
    }
    setBusy('create_' + company.id);
    try {
      await createCompanyAuction(profile.uid, company.id, startingPrice);
      setExpandedCompany(null);
      showToast(ar ? 'تم إدراج الشركة في مزاد لمدة 24 ساعة.' : 'Company listed in a 24-hour auction.', 'success');
    } catch {
      showToast(ar ? 'تعذر إنشاء المزاد. تحقق من المستوى والسعر وحالة الشركة.' : 'Could not create auction. Check level, price and company status.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function placeBid(auction: CompanyAuction) {
    const amount = Number(bidInputs[auction.id] ?? '');
    if (!Number.isSafeInteger(amount) || amount < 1) return;
    setBusy('bid_' + auction.id);
    try {
      await placeCompanyAuctionBid(profile.uid, auction.id, amount);
      showToast(ar ? 'تم تسجيل المزايدة وحجز المبلغ مؤقتاً.' : 'Bid placed and funds held in escrow.', 'success');
    } catch {
      showToast(ar ? 'تعذرت المزايدة. تحقق من الرصيد والحد الأدنى وحد امتلاك الشركات.' : 'Bid failed. Check balance, minimum bid and company ownership limit.', 'error');
    } finally {
      setBusy(null);
    }
  }

  const eligibleCompanies = companies.filter((company) => company.level >= 50 && !company.auctionId);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4">
        <div className="flex items-center gap-2 text-sm font-bold text-[#F4F5F7]"><Gavel className="w-4 h-4 text-amber-200" />{ar ? 'مزادات الشركات' : 'Company auctions'}</div>
        <p className="mt-2 text-xs text-[#B5BBC6]">
          {ar
            ? 'الشركات من المستوى 50 فما فوق فقط. مدة المزاد 24 ساعة. تُحجز المزايدة في الضمان، وتُعاد تلقائياً عند تجاوزك أو تعذر إتمام البيع.'
            : 'Level 50+ companies only. Auctions last 24 hours. Bids are held in escrow and automatically refunded when outbid or if settlement fails.'}
        </p>
      </div>

      <section className="rounded-2xl border border-white/8 bg-[#141821] p-4 space-y-3">
        <h2 className="text-sm font-semibold text-[#F4F5F7]">{ar ? 'شركاتك المؤهلة للمزاد' : 'Your eligible companies'}</h2>
        {eligibleCompanies.length === 0 ? (
          <p className="text-xs text-[#9299A6]">{ar ? 'لا توجد شركات مؤهلة حالياً. يلزم مستوى 50 على الأقل.' : 'No eligible companies yet. Company level 50 is required.'}</p>
        ) : eligibleCompanies.map((company) => {
          const minPrice = company.level * 1000;
          const maxPrice = company.level * 100000;
          const isOpen = expandedCompany === company.id;
          return (
            <div key={company.id} className="rounded-xl bg-[#0B0D12] p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[#F4F5F7] truncate">{company.name}</p>
                  <p className="text-[11px] text-[#9299A6]">{ar ? 'المستوى' : 'Level'} {company.level}</p>
                </div>
                <button type="button" onClick={() => {
                  setExpandedCompany(isOpen ? null : company.id);
                  setStartPrices((previous) => ({ ...previous, [company.id]: previous[company.id] ?? String(minPrice) }));
                }} className="min-h-[38px] px-3 rounded-lg bg-[#B91C32] text-white text-xs font-semibold">
                  {isOpen ? (ar ? 'إغلاق' : 'Close') : (ar ? 'عرض في المزاد' : 'List for auction')}
                </button>
              </div>
              {isOpen && (
                <div className="space-y-2">
                  <label className="block text-xs text-[#9299A6]">{ar ? 'سعر البداية (0 = مزاد مفتوح)' : 'Starting price (0 = open start)'}</label>
                  <input type="number" min={0} max={maxPrice} step={1} value={startPrices[company.id] ?? String(minPrice)}
                    onChange={(event) => setStartPrices((previous) => ({ ...previous, [company.id]: event.target.value }))}
                    className="w-full min-h-[42px] rounded-xl border border-white/10 bg-[#141821] px-3 text-sm text-[#F4F5F7]" />
                  <p className="text-[11px] text-[#9299A6]">{ar ? 'النطاق حسب المستوى: ' : 'Level-based range: '}{minPrice.toLocaleString()} – {maxPrice.toLocaleString()} $</p>
                  <button type="button" disabled={busy === 'create_' + company.id} onClick={() => void createAuction(company)}
                    className="w-full min-h-[40px] rounded-xl bg-amber-600 text-white text-xs font-semibold disabled:opacity-50">
                    {busy === 'create_' + company.id ? '...' : (ar ? 'تأكيد مزاد 24 ساعة' : 'Confirm 24-hour auction')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-[#F4F5F7]">{ar ? 'المزادات النشطة' : 'Active auctions'}</h2>
        {auctions.length === 0 ? (
          <div className="rounded-2xl border border-white/8 bg-[#141821] p-8 text-center text-sm text-[#9299A6]">{ar ? 'لا توجد مزادات نشطة حالياً.' : 'No active auctions right now.'}</div>
        ) : auctions.map((auction) => {
          const remaining = Math.max(0, auction.endsAt - now);
          const minBid = auction.currentBid > 0
            ? auction.currentBid + Math.max(100, Math.ceil(auction.currentBid * 0.05))
            : Math.max(1, auction.startingPrice);
          const isMine = auction.sellerUid === profile.uid;
          const isHighest = auction.highestBidderUid === profile.uid;
          return (
            <article key={auction.id} className="rounded-2xl border border-white/8 bg-[#141821] p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-[#F4F5F7] break-words">{auction.companyName}</h3>
                  <p className="mt-1 text-xs text-[#9299A6]">{ar ? 'المستوى' : 'Level'} {auction.companyLevel} · {ar ? 'البائع' : 'Seller'}: {auction.sellerName}</p>
                </div>
                <span className="shrink-0 flex items-center gap-1 rounded-lg bg-amber-400/10 px-2 py-1.5 text-xs font-mono-num text-amber-200" dir="ltr"><Clock3 className="w-3 h-3" />{formatTime(remaining)}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-[#0B0D12] p-3"><p className="text-[11px] text-[#9299A6]">{ar ? 'سعر البداية' : 'Starting price'}</p><p className="mt-1 text-sm font-semibold">{'$' + auction.startingPrice.toLocaleString()}</p></div>
                <div className="rounded-xl bg-[#0B0D12] p-3"><p className="text-[11px] text-[#9299A6]">{ar ? 'أعلى مزايدة' : 'Current bid'}</p><p className="mt-1 text-sm font-semibold text-emerald-300">{'$' + auction.currentBid.toLocaleString()}</p></div>
              </div>
              {auction.highestBidderName && <p className="text-xs text-[#9299A6]">{ar ? 'أعلى مزايد:' : 'Highest bidder:'} {auction.highestBidderName}</p>}
              {!isMine && !isHighest && remaining > 0 && (
                <div className="flex flex-col sm:flex-row gap-2">
                  <input type="number" min={minBid} step={1} value={bidInputs[auction.id] ?? String(minBid)}
                    onChange={(event) => setBidInputs((previous) => ({ ...previous, [auction.id]: event.target.value }))}
                    className="w-full min-h-[42px] rounded-xl border border-white/10 bg-[#0B0D12] px-3 text-sm text-[#F4F5F7]" />
                  <button type="button" disabled={busy === 'bid_' + auction.id || (wallet?.balance ?? 0) < minBid}
                    onClick={() => void placeBid(auction)} className="min-h-[42px] px-4 rounded-xl bg-[#B91C32] text-white text-xs font-semibold disabled:opacity-40">
                    {busy === 'bid_' + auction.id ? '...' : (ar ? 'زايد الآن' : 'Place bid')}
                  </button>
                </div>
              )}
              {isMine && <p className="text-xs text-amber-200">{ar ? 'هذا مزاد شركتك.' : 'This is your company auction.'}</p>}
              {isHighest && <p className="text-xs text-emerald-300">{ar ? 'أنت صاحب أعلى مزايدة حالياً.' : 'You currently hold the highest bid.'}</p>}
              <p className="text-[11px] text-[#9299A6]">{ar ? 'الحد الأدنى للمزايدة التالية:' : 'Next minimum bid:'} {'$' + minBid.toLocaleString()}</p>
            </article>
          );
        })}
      </section>
    </div>
  );
}
