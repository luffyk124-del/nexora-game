import type {
  AchievementDefinition,
  CatalogItem,
  CompanySector,
  ManufacturingRecipe,
  MissionDefinition,
  OrgPermission,
  OrgRole,
  PropertyType,
  SkillKey,
  TradeContract,
} from '../types/game';

export const BRAND_ASSETS = {
  emblem: '/src/assets/images/nexora_emblem_1794737992806.jpg',
  marketBanner: '/src/assets/images/world_market_banner_1794737994643.jpg',
};

export const AVATARS = [
  {
    id: 'strategist',
    labelAr: 'المخطط الاستراتيجي',
    labelEn: 'Corporate Strategist',
    src: '/src/assets/images/avatar_strategist_1794737993416.jpg',
  },
  {
    id: 'industrialist',
    labelAr: 'الرائد الصناعي',
    labelEn: 'Tech Industrialist',
    src: '/src/assets/images/avatar_industrialist_1794737993767.jpg',
  },
  {
    id: 'financier',
    labelAr: 'المهندس المالي',
    labelEn: 'Executive Financier',
    src: '/src/assets/images/avatar_financier_1794737994701.jpg',
  },
];

export const STARTING_CREDITS = 2500;
export const BASE_MARKET_TAX_RATE = 0.05; // 5%
export const ORG_CREATION_COST = 1000;
export const DAILY_STIPEND_BASE = 450;

export interface SkillDefinition {
  key: SkillKey;
  nameAr: string;
  nameEn: string;
  effectAr: string;
  effectEn: string;
  maxLevel: number;
}

export const SKILL_DEFINITIONS: SkillDefinition[] = [
  {
    key: 'trade',
    nameAr: 'التجارة',
    nameEn: 'Trade',
    effectAr: 'تخفض ضريبة السوق بمقدار 0.4% لكل مستوى وتزيد أرباح التبادل.',
    effectEn: 'Reduces market tax by 0.4% per level and boosts trade margin.',
    maxLevel: 10,
  },
  {
    key: 'management',
    nameAr: 'الإدارة',
    nameEn: 'Management',
    effectAr: 'ترفع كفاءة وإيرادات الشركات بنسبة 8% لكل مستوى.',
    effectEn: 'Increases company hourly revenue efficiency by 8% per level.',
    maxLevel: 10,
  },
  {
    key: 'industry',
    nameAr: 'الصناعة',
    nameEn: 'Industry',
    effectAr: 'تقلل تكلفة التشغيل التصنيعي بنسبة 6% لكل مستوى وتفتح الوصفات المتقدمة.',
    effectEn: 'Cuts manufacturing processing cost by 6% per level and unlocks recipes.',
    maxLevel: 10,
  },
  {
    key: 'negotiation',
    nameAr: 'التفاوض',
    nameEn: 'Negotiation',
    effectAr: 'ترفع عوائد إيجار العقارات والعقود التجارية بنسبة 7% لكل مستوى.',
    effectEn: 'Boosts property rent yield and contract payouts by 7% per level.',
    maxLevel: 10,
  },
  {
    key: 'finance',
    nameAr: 'التحليل المالي',
    nameEn: 'Financial Analysis',
    effectAr: 'تخفض مصاريف تشغيل الشركات بنسبة 5% لكل مستوى وتزيد مكافأة التشغيل اليومي.',
    effectEn: 'Reduces company expenses by 5% per level and boosts daily stipend.',
    maxLevel: 10,
  },
  {
    key: 'leadership',
    nameAr: 'القيادة',
    nameEn: 'Leadership',
    effectAr: 'تزيد مكاسب النفوذ والسمعة من المهام والمنظمات بنسبة 10% لكل مستوى.',
    effectEn: 'Increases Reputation and Influence gains by 10% per level.',
    maxLevel: 10,
  },
];

export const CATALOG_ITEMS: CatalogItem[] = [
  {
    id: 'silicon_ore',
    nameAr: 'خام السيليكون',
    nameEn: 'Silicon Ore',
    tier: 'raw',
    basePrice: 35,
    unitWeight: 1,
    descriptionAr: 'معدن أساسي لتصنيع الرقائق الدقيقة وأنظمة الحوسبة.',
    descriptionEn: 'Primary mineral for microchips and computing architecture.',
  },
  {
    id: 'copper_wire',
    nameAr: 'أسلاك النحاس',
    nameEn: 'Copper Wire',
    tier: 'raw',
    basePrice: 28,
    unitWeight: 1,
    descriptionAr: 'موصلات كهربائية عالية النقاء للوحات والطاقة.',
    descriptionEn: 'High-purity electrical conductors for boards and power grids.',
  },
  {
    id: 'energy_cells',
    nameAr: 'خلايا الطاقة',
    nameEn: 'Energy Cells',
    tier: 'raw',
    basePrice: 45,
    unitWeight: 1,
    descriptionAr: 'وحدات طاقة مركزة لتشغيل خطوط الإنتاج المتقدمة.',
    descriptionEn: 'Concentrated power units driving advanced production lines.',
  },
  {
    id: 'crude_alloy',
    nameAr: 'سبائك خام',
    nameEn: 'Crude Alloy',
    tier: 'raw',
    basePrice: 40,
    unitWeight: 2,
    descriptionAr: 'معادن مصهورة لهياكل الآلات والمركبات اللوجستية.',
    descriptionEn: 'Smelted metals for machinery frames and logistics vehicles.',
  },
  {
    id: 'carbon_fiber',
    nameAr: 'ألياف الكربون',
    nameEn: 'Carbon Fiber',
    tier: 'raw',
    basePrice: 55,
    unitWeight: 1,
    descriptionAr: 'مادة خفيفة عالية المتانة للمعدات الجوية والصناعية.',
    descriptionEn: 'Lightweight high-tensile material for aerial and industrial rigs.',
  },
  {
    id: 'rare_minerals',
    nameAr: 'معادن نادرة',
    nameEn: 'Rare Minerals',
    tier: 'raw',
    basePrice: 70,
    unitWeight: 1,
    descriptionAr: 'عناصر دقيقة تدخل في البوليمرات والأنظمة الحيوية.',
    descriptionEn: 'Precision elements used in polymers and bio-systems.',
  },
  {
    id: 'microchips',
    nameAr: 'رقائق دقيقة',
    nameEn: 'Microchips',
    tier: 'intermediate',
    basePrice: 145,
    unitWeight: 1,
    descriptionAr: 'معالجات منطقية وسيطة تدخل في الخوادم والطائرات المسيرة.',
    descriptionEn: 'Intermediate logic processors for servers and autonomous drones.',
  },
  {
    id: 'precision_frame',
    nameAr: 'هياكل دقيقة',
    nameEn: 'Precision Frame',
    tier: 'intermediate',
    basePrice: 175,
    unitWeight: 2,
    descriptionAr: 'هياكل هندسية مقاومة للإجهاد الحراري والميكانيكي.',
    descriptionEn: 'Engineered chassis resistant to thermal and mechanical stress.',
  },
  {
    id: 'synth_polymer',
    nameAr: 'بوليمر صناعي',
    nameEn: 'Synth Polymer',
    tier: 'intermediate',
    basePrice: 190,
    unitWeight: 1,
    descriptionAr: 'مركب صناعي فائق العزل للاستخدامات الطبية والتقنية.',
    descriptionEn: 'High-insulation industrial compound for tech and bio modules.',
  },
  {
    id: 'quantum_server',
    nameAr: 'خادم كمومي',
    nameEn: 'Quantum Server',
    tier: 'final',
    basePrice: 560,
    unitWeight: 3,
    descriptionAr: 'منتج نهائي عالي القيمة لمراكز البيانات والشركات التقنية.',
    descriptionEn: 'High-value final product for data centers and tech firms.',
  },
  {
    id: 'logistics_drone',
    nameAr: 'طائرة شحن ذاتية',
    nameEn: 'Logistics Drone',
    tier: 'final',
    basePrice: 620,
    unitWeight: 3,
    descriptionAr: 'مركبة نقل جوي مستقلة ترفع كفاءة سلاسل الإمداد.',
    descriptionEn: 'Autonomous cargo aircraft elevating supply chain throughput.',
  },
  {
    id: 'bio_module',
    nameAr: 'وحدة حيوية متقدمة',
    nameEn: 'Bio-Tech Module',
    tier: 'final',
    basePrice: 680,
    unitWeight: 2,
    descriptionAr: 'منظومة حيوية دقيقة ذات طلب مرتفع في الأسواق العالمية.',
    descriptionEn: 'Precision bio-system commanding strong global market demand.',
  },
];

export const ITEM_MAP: Record<string, CatalogItem> = Object.fromEntries(
  CATALOG_ITEMS.map((item) => [item.id, item])
);

export const MANUFACTURING_RECIPES: ManufacturingRecipe[] = [
  {
    id: 'rec_microchips',
    outputItemId: 'microchips',
    outputQty: 2,
    inputs: [
      { itemId: 'silicon_ore', qty: 2 },
      { itemId: 'copper_wire', qty: 2 },
    ],
    processingCost: 40,
    xpReward: 45,
    requiredIndustrySkill: 0,
  },
  {
    id: 'rec_precision_frame',
    outputItemId: 'precision_frame',
    outputQty: 2,
    inputs: [
      { itemId: 'crude_alloy', qty: 2 },
      { itemId: 'carbon_fiber', qty: 1 },
    ],
    processingCost: 50,
    xpReward: 55,
    requiredIndustrySkill: 0,
  },
  {
    id: 'rec_synth_polymer',
    outputItemId: 'synth_polymer',
    outputQty: 2,
    inputs: [
      { itemId: 'energy_cells', qty: 2 },
      { itemId: 'rare_minerals', qty: 1 },
    ],
    processingCost: 60,
    xpReward: 65,
    requiredIndustrySkill: 1,
  },
  {
    id: 'rec_quantum_server',
    outputItemId: 'quantum_server',
    outputQty: 1,
    inputs: [
      { itemId: 'microchips', qty: 2 },
      { itemId: 'energy_cells', qty: 1 },
    ],
    processingCost: 90,
    xpReward: 110,
    requiredIndustrySkill: 1,
  },
  {
    id: 'rec_logistics_drone',
    outputItemId: 'logistics_drone',
    outputQty: 1,
    inputs: [
      { itemId: 'precision_frame', qty: 2 },
      { itemId: 'microchips', qty: 1 },
    ],
    processingCost: 110,
    xpReward: 125,
    requiredIndustrySkill: 2,
  },
  {
    id: 'rec_bio_module',
    outputItemId: 'bio_module',
    outputQty: 1,
    inputs: [
      { itemId: 'synth_polymer', qty: 2 },
      { itemId: 'rare_minerals', qty: 2 },
    ],
    processingCost: 125,
    xpReward: 140,
    requiredIndustrySkill: 2,
  },
];

export interface CompanySectorSpec {
  sector: CompanySector;
  nameAr: string;
  nameEn: string;
  foundingCost: number;
  baseRevenuePerHour: number;
  baseExpensePerHour: number;
  initialEmployees: number;
}

export const COMPANY_SECTORS: CompanySectorSpec[] = [
  {
    sector: 'trade',
    nameAr: 'التجارة والتوزيع',
    nameEn: 'Trade & Distribution',
    foundingCost: 900,
    baseRevenuePerHour: 140,
    baseExpensePerHour: 35,
    initialEmployees: 3,
  },
  {
    sector: 'services',
    nameAr: 'الخدمات المؤسسية',
    nameEn: 'Corporate Services',
    foundingCost: 1100,
    baseRevenuePerHour: 175,
    baseExpensePerHour: 45,
    initialEmployees: 4,
  },
  {
    sector: 'logistics',
    nameAr: 'النقل والخدمات اللوجستية',
    nameEn: 'Transport & Logistics',
    foundingCost: 1400,
    baseRevenuePerHour: 225,
    baseExpensePerHour: 60,
    initialEmployees: 5,
  },
  {
    sector: 'manufacturing',
    nameAr: 'التصنيع المتقدم',
    nameEn: 'Advanced Manufacturing',
    foundingCost: 1800,
    baseRevenuePerHour: 290,
    baseExpensePerHour: 80,
    initialEmployees: 6,
  },
  {
    sector: 'tech',
    nameAr: 'التكنولوجيا والأنظمة',
    nameEn: 'Technology & Systems',
    foundingCost: 2200,
    baseRevenuePerHour: 365,
    baseExpensePerHour: 95,
    initialEmployees: 7,
  },
];

export interface PropertySpec {
  type: PropertyType;
  nameAr: string;
  nameEn: string;
  purchasePrice: number;
  rentPerHour: number;
  maintenancePerHour: number;
}

export const PROPERTY_SPECS: PropertySpec[] = [
  {
    type: 'shop',
    nameAr: 'متجر تجاري مركزي',
    nameEn: 'Central Retail Shop',
    purchasePrice: 950,
    rentPerHour: 115,
    maintenancePerHour: 25,
  },
  {
    type: 'office',
    nameAr: 'مقر مكاتب تنفيذية',
    nameEn: 'Executive Office Suite',
    purchasePrice: 1650,
    rentPerHour: 205,
    maintenancePerHour: 45,
  },
  {
    type: 'facility',
    nameAr: 'منشأة لوجستية وصناعية',
    nameEn: 'Industrial Logistics Facility',
    purchasePrice: 2800,
    rentPerHour: 350,
    maintenancePerHour: 80,
  },
];

export const TRADE_CONTRACTS: TradeContract[] = [
  {
    id: 'ctr_chip_batch',
    titleAr: 'توريد رقائق لمعامل السحابة',
    titleEn: 'Cloud Lab Microchip Supply',
    clientAr: 'مجموعة المدار التقنية',
    clientEn: 'Orbit Tech Group',
    requiredItemId: 'microchips',
    requiredQty: 2,
    payoutCredits: 420,
    xpReward: 75,
    reputationReward: 12,
  },
  {
    id: 'ctr_drone_fleet',
    titleAr: 'تجهيز أسطول شحن سريع',
    titleEn: 'Express Cargo Drone Fleet',
    clientAr: 'تحالف الموانئ الحرة',
    clientEn: 'Freeport Logistics Alliance',
    requiredItemId: 'logistics_drone',
    requiredQty: 1,
    payoutCredits: 890,
    xpReward: 145,
    reputationReward: 24,
  },
  {
    id: 'ctr_quantum_node',
    titleAr: 'تركيب عقدة خادم كمومي',
    titleEn: 'Quantum Node Deployment',
    clientAr: 'مصرف الأفق المركزي',
    clientEn: 'Horizon Central Bank',
    requiredItemId: 'quantum_server',
    requiredQty: 1,
    payoutCredits: 840,
    xpReward: 135,
    reputationReward: 22,
  },
];

export const MISSIONS: MissionDefinition[] = [
  {
    id: 'tut_first_trade',
    category: 'tutorial',
    titleAr: 'دخول السوق المفتوح',
    titleEn: 'Enter the Open Market',
    descriptionAr: 'نفّذ أول صفقة شراء أو بيع في سوق NEXORA.',
    descriptionEn: 'Complete your first buy or sell trade on the NEXORA market.',
    rewardCredits: 450,
    rewardXp: 90,
    rewardReputation: 10,
    targetCount: 1,
    metric: 'trades',
  },
  {
    id: 'tut_first_production',
    category: 'tutorial',
    titleAr: 'تشغيل خط الإنتاج',
    titleEn: 'Start Production Line',
    descriptionAr: 'قم بتصنيع عنصر واحد على الأقل من المواد الخام.',
    descriptionEn: 'Manufacture at least 1 intermediate or final item from raw resources.',
    rewardCredits: 550,
    rewardXp: 110,
    rewardReputation: 15,
    targetCount: 1,
    metric: 'produced',
  },
  {
    id: 'tut_first_company',
    category: 'tutorial',
    titleAr: 'تأسيس الكيان التجاري',
    titleEn: 'Found Your First Company',
    descriptionAr: 'أنشئ شركتك الأولى في أحد القطاعات الاقتصادية.',
    descriptionEn: 'Establish your first company in any economic sector.',
    rewardCredits: 850,
    rewardXp: 160,
    rewardReputation: 25,
    targetCount: 1,
    metric: 'companies',
  },
  {
    id: 'daily_active_trader',
    category: 'daily',
    titleAr: 'تاجر اليوم النشط',
    titleEn: 'Active Market Trader',
    descriptionAr: 'أتمم 3 صفقات في السوق لتنشيط السيولة.',
    descriptionEn: 'Complete 3 market trades to drive liquidity.',
    rewardCredits: 600,
    rewardXp: 120,
    rewardReputation: 14,
    targetCount: 3,
    metric: 'trades',
  },
  {
    id: 'weekly_real_estate',
    category: 'weekly',
    titleAr: 'توسيع المحفظة العقارية',
    titleEn: 'Real Estate Expansion',
    descriptionAr: 'امتلك عقاراً واحداً على الأقل لتحصيل الإيجارات.',
    descriptionEn: 'Own at least 1 real estate property to collect rent.',
    rewardCredits: 950,
    rewardXp: 210,
    rewardReputation: 28,
    targetCount: 1,
    metric: 'properties',
  },
  {
    id: 'seasonal_syndicate',
    category: 'seasonal',
    titleAr: 'تحالف النخبة الاقتصادي',
    titleEn: 'Economic Syndicate Alliance',
    descriptionAr: 'انضم إلى منظمة أو أسّس منظمتك الخاصة.',
    descriptionEn: 'Join an organization or establish your own syndicate.',
    rewardCredits: 1200,
    rewardXp: 260,
    rewardReputation: 35,
    targetCount: 1,
    metric: 'org',
  },
];

export const ACHIEVEMENTS: AchievementDefinition[] = [
  {
    id: 'ach_merchant',
    titleAr: 'تاجر السوق',
    titleEn: 'Market Merchant',
    descriptionAr: 'إتمام 5 صفقات تجارية ناجحة.',
    descriptionEn: 'Complete 5 successful market trades.',
    metric: 'trades',
    threshold: 5,
  },
  {
    id: 'ach_industrial_pioneer',
    titleAr: 'رائد التصنيع',
    titleEn: 'Industrial Pioneer',
    descriptionAr: 'إنتاج 5 وحدات صناعية.',
    descriptionEn: 'Manufacture 5 industrial units.',
    metric: 'produced',
    threshold: 5,
  },
  {
    id: 'ach_tycoon',
    titleAr: 'مؤسس إمبراطورية',
    titleEn: 'Corporate Founder',
    descriptionAr: 'امتلاك شركتين أو أكثر.',
    descriptionEn: 'Own 2 or more companies.',
    metric: 'companies',
    threshold: 2,
  },
  {
    id: 'ach_landlord',
    titleAr: 'قطب العقارات',
    titleEn: 'Property Magnate',
    descriptionAr: 'امتلاك عقارين أو أكثر.',
    descriptionEn: 'Own 2 or more real estate properties.',
    metric: 'properties',
    threshold: 2,
  },
  {
    id: 'ach_level_5',
    titleAr: 'قيادي صاعد',
    titleEn: 'Rising Executive',
    descriptionAr: 'الوصول إلى المستوى 5.',
    descriptionEn: 'Reach player Level 5.',
    metric: 'level',
    threshold: 5,
  },
  {
    id: 'ach_reputation_100',
    titleAr: 'اسم موثوق',
    titleEn: 'Trusted Name',
    descriptionAr: 'تجاوز 100 نقطة سمعة.',
    descriptionEn: 'Exceed 100 Reputation points.',
    metric: 'reputation',
    threshold: 100,
  },
];

export const ROLE_DEFAULT_PERMISSIONS: Record<OrgRole, OrgPermission[]> = {
  leader: ['manage_members', 'manage_roles', 'manage_treasury', 'manage_org'],
  deputy: ['manage_members', 'manage_roles', 'manage_treasury'],
  officer: ['manage_members'],
  member: [],
};

export const SEED_MARKET_LISTINGS = [
  { id: 'seed_silicon_ore', itemId: 'silicon_ore', quantity: 250, unitPrice: 35 },
  { id: 'seed_copper_wire', itemId: 'copper_wire', quantity: 250, unitPrice: 28 },
  { id: 'seed_energy_cells', itemId: 'energy_cells', quantity: 200, unitPrice: 45 },
  { id: 'seed_crude_alloy', itemId: 'crude_alloy', quantity: 200, unitPrice: 40 },
  { id: 'seed_carbon_fiber', itemId: 'carbon_fiber', quantity: 160, unitPrice: 55 },
  { id: 'seed_rare_minerals', itemId: 'rare_minerals', quantity: 140, unitPrice: 70 },
];

export const SEED_WORLD_EVENTS = [
  {
    id: 'evt_silicon_boom',
    titleAr: 'طفرة الطلب على الرقائق',
    titleEn: 'Silicon & Microchip Demand Surge',
    descriptionAr: 'ارتفاع الطلب العالمي على أشباه الموصلات يرفع جاذبية خام السيليكون والرقائق الدقيقة (+18%).',
    descriptionEn: 'Global semiconductor demand boosts Silicon Ore & Microchip market valuations (+18%).',
    effectType: 'demand_surge' as const,
    targetItemId: 'microchips',
    priceMultiplier: 1.18,
    taxDelta: 0,
    active: true,
  },
  {
    id: 'evt_tax_holiday',
    titleAr: 'حافز التجارة الحرة',
    titleEn: 'Free Trade Tax Incentive',
    descriptionAr: 'خفض مؤقت في ضريبة معاملات السوق بمقدار 1% لتشجيع الصفقات بين اللاعبين.',
    descriptionEn: 'Temporary 1% reduction in open market transaction tax to stimulate player trading.',
    effectType: 'tax_cut' as const,
    targetItemId: '',
    priceMultiplier: 1.0,
    taxDelta: -0.01,
    active: true,
  },
];
