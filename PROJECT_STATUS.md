# حالة مشروع NEXORA — المرجع الرسمي (`PROJECT_STATUS.md`)

> آخر تحديث: `2026-11-15`  
> الإصدار الوظيفي الموثق: `1.1.1` (تغييرات السمعة والأحداث موجودة على فرع التطوير ولم تُعتمد كإصدار بعد)  
> المستودع المستهدف: `https://github.com/luffyk124-del/nexora-game`

---

## 1. نظرة عامة
- **فكرة اللعبة**: **NEXORA** لعبة محاكاة اقتصادية وإدارة شركات واستراتيجية اجتماعية تعمل داخل المتصفح بتصميم **Mobile-First (Portrait)**، تتيح للاعب البدء من الصفر وبناء ثروته ونفوذه وشركاته وعقاراته ومنظماته عبر اقتصاد مترابط وقرارات ذات أثر فعلي.
- **الأهداف**:
  - تقديم دورة لعب مترابطة (تجارة، تصنيع، شركات، عقارات، مهارات، منظمات، مهام، وتصنيفات).
  - ضمان سلامة الأرصدة ومنع التلاعب عبر معاملات Firestore الذرية وقواعد أمان صارمة.
  - واجهة عربية أصلية (`RTL`) مع دعم تبديل فوري إلى الإنجليزية (`LTR`).
- **التقنيات الرسمية المعتمدة**:
  - الواجهة: React 19, TypeScript, Vite 8, Tailwind CSS v4, Lucide Icons, Motion.
  - الخلفية والبيانات: **Firebase Authentication (Google Sign-In)** و**Cloud Firestore (Enterprise Edition)** كمنصة رسمية وحيدة للمشروع.
  - التحقق والاختبار: Vitest, TypeScript (`tsc --noEmit`), `@firebase/eslint-plugin-security-rules`.
- **المنصة المستهدفة**: متصفحات الهواتف بوضع عمودي (Portrait) أساساً، مع استجابة كاملة لسطح المكتب.

---

## 2. الحالة الحالية
- **نسبة الإنجاز التقديرية**: **~95%** من نطاق MVP + المراجعة الشاملة والاستقرار (`1.1.1`): تم إغلاق الثغرات الأمنية وإصلاحات الاستقرار والواجهة، وتقسيم حزم البناء (`manualChunks` + تحميل كسول لـ `DiagnosticsView`)، وتوسيع الاختبارات إلى `27/27` اختباراً ناجحاً. يتبقى نشر `firestore.rules` المحدثة ونشر `nexoraDiagnostics` Cloud Function Gen 2 على Firebase وتعيين صلاحية المالك وإتمام `git push` إلى GitHub.
- **المرحلة الحالية**: استكمال تدقيق وتطوير التغييرات اللاحقة لـ `1.1.1` على فرع `development/nexora-next`؛ لا يُعد الإصدار `1.2.0` مكتملاً أو معتمداً بعد.
- **آخر نقطة وصل إليها التطوير**:
  - آخر commit مستقر على `main` وقت إنشاء بيئة التطوير: `178ef86422bd31c3867e283e44d2a0421668cf74`، ويضيف نظام مستويات السمعة ومكافآتها، ويطوّر الأحداث العالمية بمدد زمنية ومجموعات تأثير وقطاعات مستهدفة، ويضيف مؤشر حالة الاتصال.
  - تم إنشاء فرع عمل مستقل `development/nexora-next` انطلاقاً من هذا commit. أضيف سير عمل GitHub Actions في `.github/workflows/ci.yml` للتحقق من قواعد Firestore وTypeScript والاختبارات وبناء الواجهة وCloud Functions. لم تظهر نتائج CI بعد؛ لذلك لا تُسجل هذه الفحوص كناجحة حتى يكتمل تشغيلها.
  - تشديد `firestore.rules` محلياً (`company_hire` المستقل، سقف رسوم السوق، مطابقة `itemId` وكمية العرض عند الشراء، قصر `manufacturing` على الوصفات الرسمية، ربط `market_orders` بمعاملة المحفظة، وتقييد `organization_requests` `allow list` بصلاحية `manage_members`).
  - إصلاح دورة الحياة في `useGameData.ts` (تصفير كامل عند تسجيل الخروج، اشتراك `myPendingOrgIds`، تحديث `utcDateKey` تلقائياً عند منتصف الليل UTC، ومنع تكرار محاولات الإنجازات) وتوحيد حدود الاقتصاد وحسابات المهام والإنجازات في `economy.ts` و`gameService.ts`.
  - تحسين الواجهة في جميع التبويبات الستة (`Auth`, `Home`, `Business`, `Market`, `Organization`, `Profile`)، وتعريب أنواع المعاملات والرتب وفئات المهام، وإضافة حالات التحميل والخطأ والحدود القصوى (`MAX`)، وتقسيم حزم البناء في `vite.config.ts`.
  - إضافة ملف اختبارات المراجعة `src/tests/audit.test.ts` (7 اختبارات إضافية، ليصل الإجمالي إلى `27/27`).

---

## 3. الأنظمة المنفذة (فعلياً في الكود)
| النظام | الحالة | الوصف المختصر |
| :--- | :--- | :--- |
| **المصادقة وإنشاء الشخصية** | منفذ (`src/features/auth/AuthOnboardingView.tsx`) | تسجيل الدخول عبر Google (`signInWithPopup`)، حجز اسم مستخدم فريد في `usernames`، اختيار صورة رمزية، وإيداع `2,500 N-Credits` + `3` نقاط مهارة. |
| **الهيكل العام والتنقل** | منفذ (`src/components/ui/AppShell.tsx`) | شريط علوي ثابت يعرض الرصيد والمستوى والإشعارات، وشريط تنقل سفلي من 5 أقسام (`الرئيسية`, `الأعمال`, `السوق`, `المنظمة`, `الشخصية`)، ودعم `RTL/LTR`. |
| **لوحة الرئيسية والعمليات اليومية** | منفذ (`src/features/home/HomeDashboardView.tsx`) | عرض ملف اللاعب والخبرة والمستوى، صرف العائد اليومي (`claimDailyStipend`) لمرة واحدة يومياً، رسم بياني لأسعار السوق، الأحداث العالمية، المهام النشطة، وسجل المعاملات. |
| **الشركات والعقارات والتصنيع** | منفذ (`src/features/business/BusinessHubView.tsx`) | تأسيس شركات في 5 قطاعات، الترقية، توظيف الموظفين، تحصيل العائد الساعي التراكمي؛ شراء العقارات (`shop`, `office`, `facility`) وتأجيرها وترقيتها وتحصيل الإيجار؛ سلاسل تصنيع 3 مستويات (`خام -> وسيط -> نهائي`). |
| **السوق المفتوح والعقود والتحويلات** | منفذ (`src/features/market/MarketHubView.tsx`) | عرض وطلب الموارد بأسعار ديناميكية وضريبة سوق متأثرة بمهارة التجارة والأحداث العالمية، شراء/بيع/إلغاء العروض، عقود تجارية يومية، وتحويلات مالية بين اللاعبين. |
| **المنظمات والصلاحيات (RBAC)** | منفذ (`src/features/organization/OrganizationHubView.tsx`) | تأسيس المنظمات، إرسال وقبول/رفض طلبات الانضمام، إدارة الرتب (`leader`, `deputy`, `officer`, `member`)، وخزينة مشتركة بالإيداع والسحب وسجل عمليات المنظمة. |
| **الملف الشخصي والمهارات والتصنيفات** | منفذ (`src/features/profile/ProfileHubView.tsx`) | شجرة 6 مهارات مؤثرة حسابياً (`trade`, `management`, `industry`, `negotiation`, `finance`, `leadership`)، المهام (تعليمية/يومية/أسبوعية/موسمية)، الإنجازات، التصنيفات (النفوذ/الشركات/المنظمات)، والإعدادات. |
| **محرك الحسابات الاقتصادية** | منفذ ومختبر (`src/lib/economy.ts`) | حسابات حتمية للضرائب، التسعير الديناميكي، صافي ربح الشركات والعقارات، تكلفة التصنيع، المستويات، والتحويلات. |
| **نظام التشخيص والمراقبة الآمن** | منفذ ومختبر (`src/features/diagnostics/*`, `functions/*`) | لوحة تشخيص قرائية مقيدة بالمالك (5 أقسام: صحة Firebase، الأنظمة الثمانية، قاعدة البيانات، التدقيق الأمني، مراقب الأخطاء المنقّح) مع تصدير JSON موحد وخادم Gen 2 Cloud Function جاهز للنشر. |

---

## 4. الأنظمة قيد التطوير والتحقق
- **نشر حزمة `firestore.rules` (`1.1.1`) المتزامن مع الواجهة الجديدة**: تم تحديث `firestore.rules` محلياً (ويجتاز `npm run lint:rules` و`audit.test.ts`) ولم يُنشر بعد في هذه المراجعة؛ وبما أن `hireCompanyStaff` باتت تصدر `type: 'company_hire'` بدلاً من `'manufacturing'`، يجب نشر `firestore.rules` المحدثة قبل أو بالتوازي مع نشر الواجهة المحدثة حتى لا ترفض القواعد القديمة (`1.1.0`) عملية توظيف الكوادر.
- **نشر Cloud Functions Gen 2 (`nexoraDiagnostics`)**: الكود مبني ومختبر محلياً في `/functions`، ويتطلب تنفيذه على خادم Firebase تفعيل خطة Blaze والخدمات المطلوبة ثم `firebase login` و`firebase deploy --only functions --project gen-lang-client-0074900177` (إضافة إلى منح المالك `diagnosticsOwner: true` أو سجل `diagnostics_admins/{uid}`).
- **تطوير GitHub**: أصبح التطوير يجري على الفرع `development/nexora-next`؛ لا تُدمج التغييرات في `main` إلا بعد المراجعة واجتياز الاختبارات.

---

## 5. الأنظمة المخطط لها (لم يبدأ تنفيذها)
- التحالفات والاتفاقيات الرسمية بين المنظمات (Organization Alliances & Treaties).
- أهداف وتحديات جماعية أسبوعية/موسمية على مستوى المنظمة.
- عناصر تجميلية قابلة للفتح والشارات المخصصة للملفات الشخصية.
- سجل تاريخي زمني ممتد لأسعار السلع ووظائف خلفية مجدولة عبر Cloud Functions عند الحاجة للتوسع.

---

## 6. قاعدة البيانات (Cloud Firestore)
- **معرّف قاعدة البيانات**: `ai-studio-74843d9e-8228-49b7-a616-317cadd90bff` (في مشروع `gen-lang-client-0074900177`).
- **المجموعات المعتمدة** (موثقة بالتفصيل في `firebase-blueprint.json` و`docs/DATABASE.md`):
  - `test/connection`: نقطة فحص الاتصال بالخادم.
  - `profiles/{uid}` و`usernames/{usernameLower}` و`users_private/{uid}`: فصل البيانات العامة عن PII وحجز الأسماء الفريدة.
  - `wallets/{uid}` و`transactions/{txId}`: المحافظ والسجل المالي غير القابل للتعديل (`append-only`).
  - `inventory/{uid}_{itemId}` و`market_listings/{listingId}` و`market_orders/{orderId}`: المخزون وعروض السوق وأوامر الشراء المنفذة.
  - `companies/{companyId}` و`company_logs/{logId}` و`properties/{propertyId}`: أصول الشركات والعقارات وسجلاتها.
  - `organizations/{orgId}` و`organization_members/{orgId}_{uid}` و`organization_requests/{reqId}` و`organization_transactions/{txId}`: المنظمات والصلاحيات والخزينة.
  - `player_missions/{uid}_{missionId}` و`daily_claims/{uid}_{dateKey}` و`contract_claims/{uid}_{contractId}` و`player_achievements/{uid}_{achievementId}`: أقفال المطالبات والإنجازات.
  - `notifications/{notifId}` و`world_events/{eventId}` و`audit_logs/{logId}`: الإشعارات والأحداث العالمية وسجل التدقيق.
  - `diagnostics_admins/{uid}`: سجل قرائي مدار إدارياً لصلاحيات مالك التشخيص (`allow list, create, update, delete: if false`).
- **العلاقات والفهارس**: جميع قوائم التصنيف والمنظمات تجمع `where(field, '>=', 0)` مع `orderBy(field, 'desc')` على نفس الحقل لاستخدام الفهارس الأحادية تلقائياً دون فشل فهارس مركبة، كما تخضع جميع قواعد `allow list` لقيود صريحة على `resource.data`.

---

## 7. المصادقة والمستخدمون
- تسجيل الدخول يتم حصرياً عبر **Google Sign-In (`signInWithPopup`)**.
- جميع عمليات القراءة والكتابة في `firestore.rules` (عدا `test/connection`) تشترط `request.auth != null && request.auth.token.email_verified == true`.
- بيانات PII (`email`) معزولة بالكامل في `users_private/{uid}` (قراءة وتعديل المالك فقط).

---

## 8. الأمان والصلاحيات
- **إزالة قواعد `allow list: if isSignedIn();` المفتوحة**: جميع المجموعات أصبحت تقيد قوائمها عبر شروط `resource.data` (الملكية، الحالة `'active'` / `'pending'`، النطاق `>= 0`، أو `uid`/`orgId`).
- **منع التعديل المباشر من العميل على الأرصدة والتقدم**:
  - `wallets/{uid}`: يتطلب إنشاء `transactions/{txId}` ذرية متطابقة الحسابات (`isWalletDeltaValid` + `isAuthorizedTransaction`).
  - `profiles/{uid}`: مقسم إلى 4 إجراءات (`affectedKeys`)؛ زيادة `xp`/`level`/`skillPoints`/`reputation`/`influence` تتطلب معاملة محفظة ذرية (`hasNewWalletTx`).
  - `inventory/{docId}`: يمنع توليد العناصر مجاناً؛ أي زيادة تتطلب `market_buy` أو `manufacturing` أو إلغاء عرض سوق موثق (`lastListingId`).
  - `market_listings/{listingId}`: الإنشاء يخصم المخزون، الشراء يتحقق من `market_buy` في المحفظة، والإلغاء يرد المخزون ذرياً.
  - `companies` و`properties`: الأرباح/الإيجارات الأساسية ومصاريف الصيانة ثابتة لا تُعدل من العميل، والترقية والتوظيف والتحصيل تتطلب معاملات محفظة ذرية مع حد زمني نسبي لتحصيل الإيراد (`request.time - lastCollectedAt`).
  - `organizations`: الإيداع والسحب مقترنان بـ `org_deposit` / `org_withdraw`، وصلاحيات الإدارة مفروضة خادمياً عبر `hasOrgPermission`.
  - `diagnostics_admins/{uid}` و`nexoraDiagnostics`: وصول مقيد بالمالك فقط، قراءة فقط، رفض التعديل والاستعلامات العشوائية، وتنقيح الأسرار وPII.

---

## 9. الملفات المهمة
- `index.html`, `metadata.json`, `src/index.css`, `src/main.tsx`, `src/App.tsx`: نقطة الدخول والهوية البصرية.
- `src/types/game.ts`: نماذج البيانات TypeScript.
- `src/data/catalog.ts`: الكتالوج الثابت للسلع والوصفات والقطاعات والعقارات والمهام والأحداث.
- `src/lib/economy.ts`, `src/lib/diagnosticsSanitizer.ts`: محرك الحسابات الاقتصادية ومنقّح الأسرار ومراقب الأخطاء.
- `src/lib/firebase.ts`: تهيئة Firebase Auth وFirestore وFunctions وفحص الاتصال ومعالج الأخطاء `handleFirestoreError`.
- `src/services/gameService.ts`, `src/services/diagnosticsService.ts`: المعاملات الذرية لعمليات اللعبة وخدمة التشخيص القرائية.
- `src/hooks/useGameData.ts`: مستمعو `onSnapshot` وإدارة الجلسة وصلاحيات الاستماع.
- `src/i18n/translations.ts`: نصوص الواجهة العربية والإنجليزية.
- `src/features/*` و`src/components/ui/*`: شاشات ومكونات الواجهة بما فيها `src/features/diagnostics/DiagnosticsView.tsx`.
- `functions/src/index.ts`, `functions/src/diagnosticsCore.ts`, `firebase.json`: دالة Cloud Functions Gen 2 ونواتها الأمنية.
- `firestore.rules`, `firebase-blueprint.json`, `security_spec.md`, `eslint.config.js`: القواعد والمخطط ومواصفات الأمان.
- `src/tests/economy.test.ts`, `src/tests/diagnostics.test.ts`, `src/tests/audit.test.ts`: اختبارات Vitest (`27` اختباراً إجمالياً).
- `README.md`, `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/DIAGNOSTICS.md`, `PROJECT_STATUS.md`: التوثيق الرسمي الموحد.

---

## 10. الاختبارات والتحقق
- `npm run lint:rules` (`eslint firestore.rules`): ناجح (خروج `0`، 0 أخطاء، 0 تحذيرات).
- `npx tsc --noEmit`: ناجح (خروج `0`، 0 أخطاء).
- `npm run build --prefix functions`: ناجح (بناء `functions/lib/` دون أخطاء).
- `npm run test` (`vitest run`): ناجح (`27/27` اختباراً — `10/10` في `economy.test.ts` + `10/10` في `diagnostics.test.ts` + `7/7` في `audit.test.ts`).
- `npm run build` (`vite build`): ناجح (بناء `dist/` في `1.12s` مع تقسيم الحزم إلى `index` `222.28 kB` و`DiagnosticsView` الكسول `23.84 kB` و`react-vendor` `404.70 kB` و`firebase` `583.27 kB` و`icons` `33.17 kB`).
- **ملاحظة نشر**: في حزمة `1.1.1` لم يُنفذ نشر `firestore.rules` أو Cloud Functions Gen 2 (`nexoraDiagnostics`) التزاماً بتعليمات عدم النشر قبل الاعتماد؛ القواعد والوظائف جاهزة ومحققة محلياً.
- **مراجعة ما قبل النشر (`Pre-Deployment Audit`)**: تم تأكيد `projectId: gen-lang-client-0074900177` ووجود قاعدة البيانات المسماة `ai-studio-74843d9e-8228-49b7-a616-317cadd90bff` فعلياً عبر Firestore REST API، وتشديد فحص المالك بإزالة قبول `claims.admin === true` منفرداً واشتراط `claims.diagnosticsOwner === true` صراحةً، مع اشتراط `role === 'owner'` في `diagnostics_admins/{uid}` وإضافة `"database"` في `firebase.json`.

---

## 11. المشكلات المفتوحة والمغلقة
- **مغلقة**:
  - إغلاق ثغرات التعديل المباشر في `firestore.rules`، وفصل معاملات توظيف الكوادر (`company_hire`)، وتقييد `organization_requests` `allow list` على `manage_members`، وحماية `market_orders` و`inventory` عند الشراء والتصنيع.
  - معالجة حالات التسجيل الخروج، وتبديل الحسابات، وإشعارات الأخطاء، والتعريب الكامل، وتقسيم حزم البناء في الواجهة.
  - بناء نظام التشخيص والمراقبة الآمن (`NEXORA Diagnostics System`) مع حجب PII/الأسرار واختبار رفض غير المصرح لهم والتعديل والاستعلامات العشوائية، وتشديد `diagnosticsOwner`.
- **مفتوحة**:
  1. **نشر `firestore.rules` المحدثة (`1.1.1`)**: لازم قبل اختبار توظيف الكوادر (`company_hire`) في الإنتاج.
  2. **نشر Cloud Functions Gen 2 ومنح صلاحية المالك**: يتطلب خطة **Blaze** وتفعيل خدمات `cloudfunctions.googleapis.com` و`cloudbuild.googleapis.com` و`run.googleapis.com` و`artifactregistry.googleapis.com` في مشروع `gen-lang-client-0074900177`، ثم `firebase login` و`firebase deploy --only functions --project gen-lang-client-0074900177` وتعيين Custom Claim `diagnosticsOwner: true` أو سجل `diagnostics_admins/{uid}` (`enabled: true`, `role: "owner"`).
  3. **التحقق من GitHub Actions**: أُضيف `.github/workflows/ci.yml` على فرع التطوير؛ ننتظر أول تشغيل فعلي للتحقق من صلاحية خطوات التثبيت والبناء والاختبارات.
  4. **التحقق الحي في المتصفح**: مراجعة تجربة اللاعب الفعلية بعد نشر حزمة `1.1.1`.

---

## 12. القرارات التقنية
- **اعتماد Firebase Auth + Cloud Firestore كمنصة رسمية وحيدة**: توفير مصادقة Google فورية، ومزامنة لحظية عبر `onSnapshot`، وتنفيذ ذري عبر `runTransaction` محمي بقواعد خادمية صارمة.
- **استخدام فهارس أحادية في استعلامات التصنيف**: الجمع بين `where(field, '>=', 0)` و`orderBy(field, 'desc')` على نفس الحقل لفرض قيود `allow list` دون الحاجة إلى فهارس مركبة يدوية.
- **فصل الحسابات الحتمية في `src/lib/economy.ts`**: لضمان اختبارها بـ Vitest وتوحيدها across UI & Services.
- **فصل صلاحية `diagnosticsOwner` عن `admin` العام**: منع منح صلاحية التشخيص بناءً على أي `admin: true` عام دون `diagnosticsOwner: true` أو سجل `diagnostics_admins/{uid}` (`enabled: true && role: 'owner'`).

---

## 13. سجل التحديثات
| التاريخ | الملفات المتأثرة | ما تغير | السبب | نتيجة التحقق |
| :--- | :--- | :--- | :--- | :--- |
| `2026-11-15` | `.github/workflows/ci.yml`, `PROJECT_STATUS.md` | إنشاء فرع التطوير `development/nexora-next` من آخر commit، وإضافة سير CI تلقائي لفحوص TypeScript وFirestore Rules وVitest وبناء الواجهة وCloud Functions، وتحديث سجل الحالة. | تجهيز بيئة تطوير معزولة عن `main` قبل استكمال التغييرات. | تم التحقق من وجود الفرع والملف على GitHub؛ نتائج CI لم تُسجل بعد. |
| `2026-11-15` | المشروع الأساسي بالكامل (`src/*`, `firestore.rules`, `firebase-blueprint.json`, `docs/*`) | بناء MVP المتكامل لـ NEXORA، قواعد الأمان، والاختبارات الأولية، ونشر القواعد الأولى. | تنفيذ وثيقة تصميم اللعبة GDD v1.0. | `lint:rules` ناجح، `vitest` `10/10`، `vite build` و`tsc` ناجحان. |
| `2026-11-15` | `firestore.rules`, `src/hooks/useGameData.ts` | تعديل `allow list` و`allow get` لـ `organizations`, `daily_claims`, `organization_members` وإضافة `handleFirestoreError` لمستمعي `onSnapshot`. | معالجة أخطاء `permission-denied` في مستمعي البداية. | تم نشر القواعد وبناء التطبيق. |
| `2026-11-15` | `src/hooks/useGameData.ts`, `firestore.rules`, `.gitignore`, `PROJECT_STATUS.md`, `CHANGELOG.md` | إضافة `orgMemberLoaded`، توسيع `.gitignore`، إنشاء `PROJECT_STATUS.md`، وتهيئة Git المحلي على `main` وربط `origin` (`d1613f7`, `5cf2bed`). | حل سباق تحميل عضوية المنظمة، وتأسيس التوثيق المستمر وربط Git. | `lint:rules`، `vitest`، `tsc`، `build`، و`DeployRules` ناجحة؛ `git push` محجوب لعدم توفر مصادقة GitHub. |
| `2026-11-15` | `firestore.rules`, `firebase-blueprint.json`, `src/services/gameService.ts`, `src/hooks/useGameData.ts`, `README.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `CHANGELOG.md`, `PROJECT_STATUS.md` | تشديد `firestore.rules` (إلغاء كل `allow list: if isSignedIn();`، وإغلاق ثغرات التلاعب في المحافظ والمخزون والسوق والشركات والعقارات والمنظمات والملف الشخصي)، تحديث استعلامات التصنيف و`cancelMarketListing` وقصر `organization_requests` على `manage_members`، نشر القواعد عبر `DeployRules`، وتوحيد التوثيق على Firebase. | تنفيذ الأولويات الخمس للمراجعة الأمنية الشاملة وتوحيد التوثيق والتحقق والرفع. | `npm run lint:rules` ناجح، `npm run test` (`10/10`)، `npx tsc --noEmit` ناجح، `npm run build` ناجح، `DeployRules` ناجح. |
| `2026-11-15` | `functions/*`, `firebase.json`, `firestore.rules`, `firebase-blueprint.json`, `src/lib/diagnosticsSanitizer.ts`, `src/services/diagnosticsService.ts`, `src/features/diagnostics/DiagnosticsView.tsx`, `src/features/profile/ProfileHubView.tsx`, `src/tests/diagnostics.test.ts`, `docs/DIAGNOSTICS.md`, `README.md`, `CHANGELOG.md`, `PROJECT_STATUS.md` | بناء **NEXORA Diagnostics System** (قراءة فقط ومقيد بالمالك، 5 أقسام، تصدير JSON منقّح، خادم Cloud Functions Gen 2، وقاعدة `diagnostics_admins/{uid}`). | إتاحة فحص صحة اللعبة وقاعدة البيانات واستخراج تقارير JSON آمنة خالية من الأسرار وPII. | `lint:rules` ناجح، `tsc --noEmit` ناجح، `functions` build ناجح، `vitest` (`20/20`)، `vite build` ناجح، `DeployRules` ناجح. |
| `2026-11-15` | `functions/src/diagnosticsCore.ts`, `functions/src/index.ts`, `src/services/diagnosticsService.ts`, `firebase.json`, `src/tests/diagnostics.test.ts`, `docs/DIAGNOSTICS.md`, `PROJECT_STATUS.md` | مراجعة ما قبل النشر: إزالة قبول `claims.admin === true` منفرداً واشتراط `claims.diagnosticsOwner === true`، التحقق من `role === 'owner'` في `diagnostics_admins/{uid}`، وتثبيت `database` في `firebase.json` (دون نشر). | تشديد التفويض بحيث لا يعتمد على `admin` العام وحده ومطابقة إعدادات قاعدة البيانات المسماة. | `lint:rules` ناجح، `tsc --noEmit` ناجح، `functions` build ناجح، `vitest` (`20/20`)، `vite build` ناجح. |
| `2026-11-15` | `firestore.rules`, `firebase-blueprint.json`, `vite.config.ts`, `src/types/game.ts`, `src/lib/economy.ts`, `src/services/gameService.ts`, `src/hooks/useGameData.ts`, `src/i18n/translations.ts`, `src/App.tsx`, `src/features/*`, `src/tests/audit.test.ts`, `README.md`, `CHANGELOG.md`, `docs/*`, `PROJECT_STATUS.md` | تنفيذ المراجعة الشاملة (`1.1.1`): فصل `company_hire` وتشديد قواعد `market_orders`/`inventory`/`organization_requests`، تصفير الحالة عند الخروج ودعم `myPendingOrgIds` وتحديث منتصف الليل UTC، تحسين أخطاء وحدود وحقول جميع الشاشات، تعريب السجل والرتب والمهام، التحميل الكسول لـ `DiagnosticsView` وتقسيم حزم `vite.config.ts`، وإضافة `audit.test.ts` (7 اختبارات). | رفع الأمان والاستقرار والأداء وتجربة اللعب وتغطية الاختبارات دون كسر البيانات الحالية أو نشر القواعد قبل الاعتماد. | `lint:rules` ناجح، `tsc --noEmit` ناجح، `functions` build ناجح، `vitest` (`27/27`)، `vite build` ناجح، `compile_applet` و`lint_applet` ناجحان. |
