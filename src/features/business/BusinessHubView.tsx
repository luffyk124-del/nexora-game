import {
  Building,
  Coins,
  Factory,
  Landmark,
  Package,
  Plus,
  TrendingUp,
  UserPlus,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useToast } from '../../components/ui/ToastProvider';
import {
  COMPANY_SECTORS,
  ITEM_MAP,
  MANUFACTURING_RECIPES,
  PROPERTY_SPECS,
} from '../../data/catalog';
import { useTranslations } from '../../i18n/translations';
import {
  calculateAccruedPayout,
  calculateCompanyHourlyNet,
  calculateManufacturingCost,
  calculatePropertyHourlyNet,
} from '../../lib/economy';
import {
  buyProperty,
  collectCompanyRevenue,
  collectPropertyRent,
  foundCompany,
  hireCompanyStaff,
  manufactureRecipe,
  timestampToMs,
  togglePropertyLease,
  upgradeCompany,
  upgradeProperty,
} from '../../services/gameService';
import type {
  BusinessSubTab,
  Company,
  CompanyLog,
  CompanySector,
  InventoryItem,
  Language,
  PlayerProfile,
  PropertyAsset,
  PropertyType,
  Wallet,
} from '../../types/game';

interface BusinessHubViewProps {
  profile: PlayerProfile;
  wallet: Wallet | null;
  companies: Company[];
  companyLogs: CompanyLog[];
  properties: PropertyAsset[];
  inventory: InventoryItem[];
  language: Language;
  onGoToMarket: () => void;
}

export function BusinessHubView({
  profile,
  wallet,
  companies,
  companyLogs,
  properties,
  inventory,
  language,
  onGoToMarket,
}: BusinessHubViewProps) {
  const t = useTranslations(language);
  const { showToast } = useToast();

  const [subTab, setSubTab] = useState<BusinessSubTab>('companies');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Found Company form
  const [newCompName, setNewCompName] = useState('');
  const [newCompSector, setNewCompSector] = useState<CompanySector>('trade');

  // Buy Property form
  const [newPropName, setNewPropName] = useState('');
  const [newPropType, setNewPropType] = useState<PropertyType>('shop');

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);

  const invMap = new Map<string, number>();
  inventory.forEach((item) => invMap.set(item.itemId, item.quantity));

  const totalCompanyNetHr = companies.reduce((sum, c) => {
    const { netHourly } = calculateCompanyHourlyNet(c, {
      management: profile.skills.management || 0,
      finance: profile.skills.finance || 0,
    });
    return sum + netHourly;
  }, 0);

  const totalPropNetHr = properties.reduce((sum, p) => {
    const { netHourly } = calculatePropertyHourlyNet(p, profile.skills.negotiation || 0);
    return sum + netHourly;
  }, 0);

  async function handleFoundCompany(e: React.FormEvent) {
    e.preventDefault();
    setBusyKey('found_company');
    try {
      await foundCompany(profile.uid, profile.username, newCompName, newCompSector);
      setNewCompName('');
      showToast(
        language === 'ar' ? 'تم تأسيس الشركة بنجاح!' : 'Company founded successfully!',
        'success'
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'INSUFFICIENT_FUNDS'
          ? language === 'ar'
            ? 'رصيدك غير كافٍ.'
            : 'Insufficient funds.'
          : language === 'ar'
          ? 'تأكد من إدخال اسم شركة صالح.'
          : 'Please enter a valid company name.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCollectCompany(companyId: string) {
    setBusyKey(`col_${companyId}`);
    try {
      const earned = await collectCompanyRevenue(profile.uid, companyId);
      showToast(
        language === 'ar' ? `تم تحصيل +${earned} N-Credits.` : `Collected +${earned} N-Credits.`,
        'success'
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'NOTHING_TO_COLLECT'
          ? language === 'ar'
            ? 'انتظر قليلاً لتراكم العائد التشغيلي.'
            : 'Wait briefly for hourly revenue to accrue.'
          : language === 'ar'
          ? 'تعذر التحصيل.'
          : 'Collection failed.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleUpgradeCompany(companyId: string) {
    setBusyKey(`upg_${companyId}`);
    try {
      await upgradeCompany(profile.uid, companyId);
      showToast(language === 'ar' ? 'تمت ترقية الشركة.' : 'Company upgraded.', 'success');
    } catch {
      showToast(language === 'ar' ? 'الرصيد غير كافٍ للترقية.' : 'Insufficient funds to upgrade.', 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleHireStaff(companyId: string) {
    setBusyKey(`hire_${companyId}`);
    try {
      await hireCompanyStaff(profile.uid, companyId);
      showToast(language === 'ar' ? 'تم توظيف كادر جديد.' : 'Staff member hired.', 'success');
    } catch {
      showToast(language === 'ar' ? 'الرصيد غير كافٍ (250 N-Credits).' : 'Insufficient funds (250).', 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleManufacture(recipeId: string) {
    setBusyKey(`mfg_${recipeId}`);
    try {
      await manufactureRecipe(profile.uid, recipeId);
      showToast(language === 'ar' ? 'تم الإنتاج بنجاح!' : 'Production completed!', 'success');
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'MISSING_INPUTS'
          ? language === 'ar'
            ? 'المدخلات غير كافية في المخزون.'
            : 'Insufficient input materials in inventory.'
          : code === 'INDUSTRY_SKILL_TOO_LOW'
          ? language === 'ar'
            ? 'مستوى مهارة الصناعة غير كافٍ لهذه الوصفة.'
            : 'Industry skill level too low for this recipe.'
          : language === 'ar'
          ? 'الرصيد غير كافٍ لتكلفة التشغيل.'
          : 'Insufficient credits for processing cost.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleBuyProperty(e: React.FormEvent) {
    e.preventDefault();
    setBusyKey('buy_prop');
    try {
      await buyProperty(profile.uid, newPropName, newPropType);
      setNewPropName('');
      showToast(language === 'ar' ? 'تم شراء العقار بنجاح!' : 'Property acquired!', 'success');
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      showToast(
        code === 'INSUFFICIENT_FUNDS'
          ? language === 'ar'
            ? 'رصيدك غير كافٍ.'
            : 'Insufficient funds.'
          : language === 'ar'
          ? 'أدخل اسماً صالحاً للعقار.'
          : 'Enter a valid property name.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCollectRent(propId: string) {
    setBusyKey(`pcol_${propId}`);
    try {
      const earned = await collectPropertyRent(profile.uid, propId);
      showToast(
        language === 'ar' ? `تم تحصيل +${earned} N-Credits إيجار.` : `Collected +${earned} N-Credits rent.`,
        'success'
      );
    } catch {
      showToast(
        language === 'ar' ? 'لم يتراكم إيجار قابل للتحصيل بعد.' : 'No accrued rent ready yet.',
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  }

  const subTabs: { id: BusinessSubTab; label: string }[] = [
    { id: 'companies', label: t.subCompanies },
    { id: 'manufacturing', label: t.subManufacturing },
    { id: 'properties', label: t.subProperties },
    { id: 'inventory', label: t.subInventory },
    { id: 'financials', label: t.subFinancials },
  ];

  return (
    <div className="space-y-5">
      {/* Segmented Sub-Navigation */}
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

      {/* 1. COMPANIES */}
      {subTab === 'companies' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Found New Company Form */}
          <form
            onSubmit={handleFoundCompany}
            className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-4 h-fit"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#F4F5F7]">{t.foundCompany}</h2>
              <Building className="w-4 h-4 text-[#E04455]" />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-[#9299A6]">{t.companyName}</label>
              <input
                type="text"
                value={newCompName}
                onChange={(e) => setNewCompName(e.target.value)}
                maxLength={48}
                required
                placeholder={language === 'ar' ? 'شركة الأفق للتجارة' : 'Horizon Trade Corp'}
                className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#0B0D12] border border-white/10 text-sm text-[#F4F5F7] focus:outline-none focus:border-[#E04455]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-[#9299A6]">{t.companySector}</label>
              <div className="space-y-2">
                {COMPANY_SECTORS.map((s) => (
                  <button
                    key={s.sector}
                    type="button"
                    onClick={() => setNewCompSector(s.sector)}
                    className={`w-full p-3 rounded-xl border text-start flex items-center justify-between transition-colors ${
                      newCompSector === s.sector
                        ? 'bg-[#1B2230] border-[#E04455]'
                        : 'bg-[#0B0D12] border-white/8 hover:border-white/20'
                    }`}
                  >
                    <div>
                      <p className="text-xs font-semibold text-[#F4F5F7]">
                        {language === 'ar' ? s.nameAr : s.nameEn}
                      </p>
                      <p className="text-[11px] text-[#9299A6] mt-0.5 font-mono-num">
                        +{s.baseRevenuePerHour - s.baseExpensePerHour}/hr
                      </p>
                    </div>
                    <span className="text-xs font-mono-num font-semibold text-[#E04455]">
                      {s.foundingCost.toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={busyKey === 'found_company'}
              className="w-full min-h-[44px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              <span>{busyKey === 'found_company' ? '...' : t.foundCompany}</span>
            </button>
          </form>

          {/* Owned Companies List */}
          <div className="lg:col-span-2 space-y-4">
            {companies.length === 0 ? (
              <div className="bg-[#141821] border border-white/8 rounded-2xl p-8 text-center">
                <p className="text-sm text-[#9299A6]">
                  {language === 'ar'
                    ? 'لا تمتلك أي شركة بعد. أسس شركتك الأولى لبدء توليد الإيرادات.'
                    : 'No companies owned yet. Found your first enterprise to generate hourly revenue.'}
                </p>
              </div>
            ) : (
              companies.map((c) => {
                const { netHourly } = calculateCompanyHourlyNet(c, {
                  management: profile.skills.management || 0,
                  finance: profile.skills.finance || 0,
                });
                const accrued = calculateAccruedPayout(
                  netHourly,
                  timestampToMs(c.lastCollectedAt),
                  nowMs
                );
                const upgradeCost = c.level * 550;
                const sectorSpec = COMPANY_SECTORS.find((s) => s.sector === c.sector);

                return (
                  <div
                    key={c.id}
                    className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-base font-bold text-[#F4F5F7]">{c.name}</h3>
                        <p className="text-xs text-[#9299A6] mt-0.5">
                          {language === 'ar' ? sectorSpec?.nameAr : sectorSpec?.nameEn} · {t.level}{' '}
                          <span className="font-mono-num text-[#F4F5F7]">{c.level}</span> ·{' '}
                          {t.employees}{' '}
                          <span className="font-mono-num text-[#F4F5F7]">{c.employeesCount}</span>
                        </p>
                      </div>
                      <div className="text-end">
                        <p className="text-xs text-[#9299A6]">{t.netPerHour}</p>
                        <p className="text-sm font-mono-num font-bold text-emerald-400">
                          +{netHourly.toLocaleString()}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 bg-[#0B0D12] border border-white/6 rounded-xl p-3.5 text-xs">
                      <div>
                        <p className="text-[#9299A6]">{language === 'ar' ? 'الإيراد المتراكم' : 'Accrued'}</p>
                        <p className="font-mono-num font-semibold text-[#F4F5F7] mt-0.5">
                          {accrued.toLocaleString()} {t.currency}
                        </p>
                      </div>
                      <div>
                        <p className="text-[#9299A6]">{language === 'ar' ? 'إجمالي العوائد' : 'Lifetime Rev'}</p>
                        <p className="font-mono-num font-semibold text-[#F4F5F7] mt-0.5">
                          {c.totalRevenue.toLocaleString()}
                        </p>
                      </div>
                      <div>
                        <p className="text-[#9299A6]">{language === 'ar' ? 'تكلفة التطوير' : 'Upgrade Cost'}</p>
                        <p className="font-mono-num font-semibold text-[#F4F5F7] mt-0.5">
                          {upgradeCost.toLocaleString()}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        disabled={accrued < 1 || busyKey === `col_${c.id}`}
                        onClick={() => handleCollectCompany(c.id)}
                        className="flex-1 min-h-[42px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-xs font-semibold whitespace-nowrap disabled:bg-[#1B2230] disabled:text-[#9299A6] transition-colors"
                      >
                        {t.collectRevenue} ({accrued})
                      </button>
                      <button
                        type="button"
                        disabled={busyKey === `upg_${c.id}` || (wallet?.balance ?? 0) < upgradeCost}
                        onClick={() => handleUpgradeCompany(c.id)}
                        className="min-h-[42px] px-3.5 rounded-xl bg-[#1B2230] hover:bg-[#232C3E] text-[#F4F5F7] text-xs font-semibold whitespace-nowrap disabled:opacity-50 transition-colors"
                      >
                        {t.upgradeCompany}
                      </button>
                      <button
                        type="button"
                        disabled={busyKey === `hire_${c.id}` || (wallet?.balance ?? 0) < 250}
                        onClick={() => handleHireStaff(c.id)}
                        className="min-h-[42px] px-3.5 rounded-xl bg-[#1B2230] hover:bg-[#232C3E] text-[#F4F5F7] text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 transition-colors"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>{t.hireStaff} (250)</span>
                      </button>
                    </div>
                  </div>
                );
              })
            )}

            {companyLogs.length > 0 && (
              <div className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-3">
                <h3 className="text-sm font-semibold text-[#F4F5F7]">
                  {language === 'ar' ? 'سجل عمليات الشركات' : 'Company Operations Log'}
                </h3>
                <div className="space-y-2">
                  {companyLogs.slice(0, 6).map((log) => (
                    <div
                      key={log.id}
                      className="flex items-center justify-between text-xs py-2 border-b border-white/6 last:border-0"
                    >
                      <span className="text-[#9299A6]">{log.details}</span>
                      <span
                        className={`font-mono-num font-semibold ${
                          log.amount >= 0 ? 'text-emerald-400' : 'text-[#E04455]'
                        }`}
                      >
                        {log.amount >= 0 ? `+${log.amount}` : log.amount}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. MANUFACTURING */}
      {subTab === 'manufacturing' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {MANUFACTURING_RECIPES.map((rec) => {
            const outputItem = ITEM_MAP[rec.outputItemId];
            const cost = calculateManufacturingCost(rec, profile.skills.industry || 0);
            const hasSkill = (profile.skills.industry || 0) >= rec.requiredIndustrySkill;
            const hasAllInputs = rec.inputs.every(
              (inp) => (invMap.get(inp.itemId) || 0) >= inp.qty
            );
            const canAfford = (wallet?.balance ?? 0) >= cost;

            return (
              <div
                key={rec.id}
                className="bg-[#141821] border border-white/8 rounded-2xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-bold text-[#F4F5F7]">
                      {language === 'ar' ? outputItem.nameAr : outputItem.nameEn} ×{rec.outputQty}
                    </h3>
                    <p className="text-xs text-[#9299A6] mt-0.5">
                      {language === 'ar' ? 'مهارة الصناعة المطلوبة:' : 'Required Industry:'}{' '}
                      <span className="font-mono-num text-[#F4F5F7]">
                        Lv.{rec.requiredIndustrySkill}
                      </span>{' '}
                      · +{rec.xpReward} XP
                    </p>
                  </div>
                  <Factory className="w-5 h-5 text-[#E04455] shrink-0" />
                </div>

                <div className="space-y-2 bg-[#0B0D12] border border-white/6 rounded-xl p-3.5">
                  {rec.inputs.map((inp) => {
                    const inpItem = ITEM_MAP[inp.itemId];
                    const owned = invMap.get(inp.itemId) || 0;
                    const ok = owned >= inp.qty;
                    return (
                      <div key={inp.itemId} className="flex items-center justify-between text-xs">
                        <span className="text-[#9299A6]">
                          {language === 'ar' ? inpItem.nameAr : inpItem.nameEn}
                        </span>
                        <span
                          className={`font-mono-num font-semibold ${
                            ok ? 'text-emerald-400' : 'text-[#E04455]'
                          }`}
                        >
                          {owned} / {inp.qty}
                        </span>
                      </div>
                    );
                  })}
                  <div className="flex items-center justify-between text-xs pt-2 border-t border-white/6">
                    <span className="text-[#9299A6]">{t.processingCost}</span>
                    <span className="font-mono-num font-semibold text-[#F4F5F7]">
                      {cost.toLocaleString()} {t.currency}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    disabled={!hasSkill || !hasAllInputs || !canAfford || busyKey === `mfg_${rec.id}`}
                    onClick={() => handleManufacture(rec.id)}
                    className="flex-1 min-h-[44px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-xs font-semibold transition-colors disabled:bg-[#1B2230] disabled:text-[#9299A6]"
                  >
                    {busyKey === `mfg_${rec.id}`
                      ? '...'
                      : !hasAllInputs
                      ? t.missingInputs
                      : t.manufactureNow}
                  </button>
                  {!hasAllInputs && (
                    <button
                      type="button"
                      onClick={onGoToMarket}
                      className="min-h-[44px] px-3.5 rounded-xl bg-[#1B2230] hover:bg-[#232C3E] text-[#F4F5F7] text-xs font-medium whitespace-nowrap"
                    >
                      {t.navMarket}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 3. PROPERTIES */}
      {subTab === 'properties' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <form
            onSubmit={handleBuyProperty}
            className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-4 h-fit"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#F4F5F7]">{t.buyProperty}</h2>
              <Landmark className="w-4 h-4 text-[#E04455]" />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-[#9299A6]">{t.propertyName}</label>
              <input
                type="text"
                value={newPropName}
                onChange={(e) => setNewPropName(e.target.value)}
                maxLength={48}
                required
                placeholder={language === 'ar' ? 'برج النخبة التجاري' : 'Apex Plaza Unit'}
                className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#0B0D12] border border-white/10 text-sm text-[#F4F5F7] focus:outline-none focus:border-[#E04455]"
              />
            </div>

            <div className="space-y-2">
              {PROPERTY_SPECS.map((p) => (
                <button
                  key={p.type}
                  type="button"
                  onClick={() => setNewPropType(p.type)}
                  className={`w-full p-3 rounded-xl border text-start flex items-center justify-between transition-colors ${
                    newPropType === p.type
                      ? 'bg-[#1B2230] border-[#E04455]'
                      : 'bg-[#0B0D12] border-white/8 hover:border-white/20'
                  }`}
                >
                  <div>
                    <p className="text-xs font-semibold text-[#F4F5F7]">
                      {language === 'ar' ? p.nameAr : p.nameEn}
                    </p>
                    <p className="text-[11px] text-[#9299A6] font-mono-num mt-0.5">
                      +{p.rentPerHour - p.maintenancePerHour}/hr
                    </p>
                  </div>
                  <span className="text-xs font-mono-num font-semibold text-[#E04455]">
                    {p.purchasePrice.toLocaleString()}
                  </span>
                </button>
              ))}
            </div>

            <button
              type="submit"
              disabled={busyKey === 'buy_prop'}
              className="w-full min-h-[44px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-sm font-semibold transition-colors disabled:opacity-50"
            >
              {busyKey === 'buy_prop' ? '...' : t.buyProperty}
            </button>
          </form>

          <div className="lg:col-span-2 space-y-4">
            {properties.length === 0 ? (
              <div className="bg-[#141821] border border-white/8 rounded-2xl p-8 text-center">
                <p className="text-sm text-[#9299A6]">
                  {language === 'ar'
                    ? 'لا تمتلك عقارات بعد. اشترِ متجراً أو مكتباً لتحصيل الإيجارات المستمرة.'
                    : 'No properties owned yet. Acquire a shop, office, or facility to earn rent.'}
                </p>
              </div>
            ) : (
              properties.map((p) => {
                const { netHourly } = calculatePropertyHourlyNet(
                  p,
                  profile.skills.negotiation || 0
                );
                const accrued = calculateAccruedPayout(
                  netHourly,
                  timestampToMs(p.lastCollectedAt),
                  nowMs
                );
                const upgradeCost = p.level * 480;

                return (
                  <div
                    key={p.id}
                    className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-base font-bold text-[#F4F5F7]">{p.name}</h3>
                        <p className="text-xs text-[#9299A6] mt-0.5">
                          {p.isRented ? t.rented : t.vacant} · {t.level}{' '}
                          <span className="font-mono-num text-[#F4F5F7]">{p.level}</span>
                        </p>
                      </div>
                      <span className="text-sm font-mono-num font-bold text-emerald-400">
                        {netHourly >= 0 ? `+${netHourly}/hr` : `${netHourly}/hr`}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        disabled={accrued < 1 || busyKey === `pcol_${p.id}`}
                        onClick={() => handleCollectRent(p.id)}
                        className="flex-1 min-h-[42px] px-4 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-xs font-semibold whitespace-nowrap disabled:bg-[#1B2230] disabled:text-[#9299A6]"
                      >
                        {t.collectRent} ({accrued})
                      </button>
                      <button
                        type="button"
                        onClick={() => togglePropertyLease(profile.uid, p.id, !p.isRented)}
                        className="min-h-[42px] px-3.5 rounded-xl bg-[#1B2230] hover:bg-[#232C3E] text-[#F4F5F7] text-xs font-semibold whitespace-nowrap"
                      >
                        {t.toggleRent}
                      </button>
                      <button
                        type="button"
                        disabled={(wallet?.balance ?? 0) < upgradeCost}
                        onClick={() => upgradeProperty(profile.uid, p.id)}
                        className="min-h-[42px] px-3.5 rounded-xl bg-[#1B2230] hover:bg-[#232C3E] text-[#F4F5F7] text-xs font-semibold whitespace-nowrap disabled:opacity-50"
                      >
                        {t.upgradeProperty} ({upgradeCost})
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* 4. INVENTORY */}
      {subTab === 'inventory' && (
        <div className="bg-[#141821] border border-white/8 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-[#F4F5F7]">{t.subInventory}</h2>
            <Package className="w-4 h-4 text-[#E04455]" />
          </div>
          {inventory.filter((i) => i.quantity > 0).length === 0 ? (
            <div className="py-10 text-center space-y-3">
              <p className="text-sm text-[#9299A6]">
                {language === 'ar'
                  ? 'مخزونك فارغ حالياً. اشترِ موارد أولية من السوق للبدء.'
                  : 'Your inventory is empty. Purchase raw resources from the Market.'}
              </p>
              <button
                type="button"
                onClick={onGoToMarket}
                className="min-h-[42px] px-5 rounded-xl bg-[#B91C32] hover:bg-[#E04455] text-white text-xs font-semibold"
              >
                {t.navMarket}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {inventory
                .filter((i) => i.quantity > 0)
                .map((inv) => {
                  const item = ITEM_MAP[inv.itemId];
                  if (!item) return null;
                  return (
                    <div
                      key={inv.itemId}
                      className="p-4 rounded-xl bg-[#0B0D12] border border-white/6 flex items-center justify-between gap-3"
                    >
                      <div>
                        <p className="text-sm font-semibold text-[#F4F5F7]">
                          {language === 'ar' ? item.nameAr : item.nameEn}
                        </p>
                        <p className="text-xs text-[#9299A6] mt-0.5">
                          ~{item.basePrice} {t.currency}
                        </p>
                      </div>
                      <span className="text-lg font-mono-num font-bold text-[#E04455]">
                        ×{inv.quantity}
                      </span>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* 5. FINANCIAL SUMMARY */}
      {subTab === 'financials' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-[#141821] border border-white/8 rounded-2xl p-5">
            <div className="flex items-center justify-between text-xs text-[#9299A6]">
              <span>{language === 'ar' ? 'إجمالي الدخل التراكمي' : 'Total Lifetime Earned'}</span>
              <TrendingUp className="w-4 h-4 text-emerald-400" />
            </div>
            <p className="text-xl font-bold font-mono-num text-[#F4F5F7] mt-2">
              {(wallet?.totalEarned ?? 0).toLocaleString()}
            </p>
          </div>

          <div className="bg-[#141821] border border-white/8 rounded-2xl p-5">
            <div className="flex items-center justify-between text-xs text-[#9299A6]">
              <span>{language === 'ar' ? 'إجمالي المصروفات' : 'Total Lifetime Spent'}</span>
              <Coins className="w-4 h-4 text-[#E04455]" />
            </div>
            <p className="text-xl font-bold font-mono-num text-[#F4F5F7] mt-2">
              {(wallet?.totalSpent ?? 0).toLocaleString()}
            </p>
          </div>

          <div className="bg-[#141821] border border-white/8 rounded-2xl p-5">
            <div className="flex items-center justify-between text-xs text-[#9299A6]">
              <span>{language === 'ar' ? 'صافي دخل الشركات / ساعة' : 'Companies Net / hr'}</span>
              <Building className="w-4 h-4 text-[#9299A6]" />
            </div>
            <p className="text-xl font-bold font-mono-num text-emerald-400 mt-2">
              +{totalCompanyNetHr.toLocaleString()}
            </p>
          </div>

          <div className="bg-[#141821] border border-white/8 rounded-2xl p-5">
            <div className="flex items-center justify-between text-xs text-[#9299A6]">
              <span>{language === 'ar' ? 'صافي العقارات / ساعة' : 'Properties Net / hr'}</span>
              <Landmark className="w-4 h-4 text-[#9299A6]" />
            </div>
            <p className="text-xl font-bold font-mono-num text-emerald-400 mt-2">
              +{totalPropNetHr.toLocaleString()}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
