import type {JsonObject} from './types.js';

// Authored artifact labels only. Never apply this map to provider values, identifiers, custom labels or evidence.
const arabic: Record<string, string> = {
  Report: 'التقرير',
  REPORT: 'التقرير',
  DETAIL: 'التفاصيل',
  Title: 'العنوان',
  Client: 'العميل',
  Period: 'الفترة',
  'Snapshot state': 'حالة النسخة',
  'Snapshot ID': 'معرّف النسخة',
  'Collected at': 'وقت الجمع',
  'Source rows': 'صفوف المصدر',
  'Source hash': 'بصمة المصدر',
  Interpretation: 'التفسير',
  Evidence: 'الأدلة',
  Values: 'القيم',
  'Prepared by': 'إعداد',
  Limitation: 'قيد',
  Note: 'ملاحظة',
  Notes: 'ملاحظات',
  'Report notices': 'تنبيهات التقرير',
  "Saved report objectives now fill gaps in the platform's objective. Numbers may change.":
    'تُستخدم أهداف التقارير المحفوظة الآن عند غياب هدف من المنصة. قد تتغير الأرقام.',
  'LinkedIn reports now show campaign groups in the campaign position, LinkedIn campaigns in the ad set position and creatives in the ad position. Earlier snapshots keep the levels they recorded.':
    'تعرض تقارير LinkedIn الآن مجموعات الحملات في موضع الحملة، وحملات LinkedIn في موضع المجموعة الإعلانية، والمواد الإعلانية في موضع الإعلان. تحتفظ النسخ السابقة بالمستويات التي سُجلت فيها.',
  'TikTok reports now include campaigns deleted since the window and check TikTok’s own totals, so past windows can show more spend than before.':
    'تشمل تقارير TikTok الآن الحملات التي حُذفت بعد الفترة وتتحقق من إجماليات TikTok نفسها، لذا قد تعرض الفترات السابقة إنفاقًا أكبر من قبل.',
  'Account summaries': 'ملخصات الحسابات',
  'Campaign rows': 'صفوف الحملات',
  'Entity rows': 'صفوف الكيانات الإعلانية',
  Aggregation: 'التجميع',
  'Result mapped from': 'النتيجة معيّنة من',
  'Rolled up from selected ads': 'مجمّع من الإعلانات المحددة',
  'Rolled up from selected child entities': 'مجمّع من الكيانات الفرعية المحددة',
  'Entity level': 'مستوى الكيان',
  'Native entity type': 'نوع الكيان الأصلي',
  'Entity ID': 'معرّف الكيان',
  Entity: 'الكيان',
  'Ad set / ad group ID': 'معرّف المجموعة الإعلانية',
  'Ad set / ad group': 'المجموعة الإعلانية',
  'Source coverage': 'تغطية المصادر',
  Coverage: 'التغطية',
  'Coverage note': 'ملاحظة التغطية',
  'Level check': 'مطابقة المستويات',
  Precision: 'الدقة',
  // The platforms' own words for a reporting level, as the website's catalog has them.
  'Campaign group': 'مجموعة الحملات',
  'Ad set': 'مجموعة إعلانات',
  'Ad group': 'المجموعة الإعلانية',
  'Ad squad': 'المجموعة الإعلانية',
  'Line item': 'بند إعلان',
  Ad: 'الإعلان',
  Creative: 'المواد الإعلانية',
  'Promoted tweet': 'تغريدة مروّجة',
  'Native rows': 'الصفوف الأصلية',
  'Metric totals': 'إجماليات المقاييس',
  'Field mappings': 'تعيين الحقول',
  'Source references': 'مراجع المصدر',
  'Evidence ID': 'معرّف البيانات',
  'Connection ID': 'معرّف الاتصال',
  Preset: 'القالب',
  'Native grain': 'مستوى تفصيل البيانات الأصلي',
  'Declared complete': 'اكتمال البيانات حسب التصريح',
  'Measurement provenance': 'مصدر إعدادات القياس',
  'Date through': 'حتى تاريخ',
  'Numeric metrics are stored as text to preserve precision; use retained totals before converting cells.':
    'تُحفظ المقاييس الرقمية كنص للحفاظ على الدقة؛ استخدم الإجماليات المحفوظة قبل تحويل الخلايا إلى أرقام.',
  'Blank cells are unknown or unmapped. See Field mappings for coverage. Attribution and completeness are retained settings, not independent verification.':
    'الخلايا الفارغة غير معروفة أو غير معيّنة. راجع ورقة تعيين الحقول لمعرفة التغطية. الإسناد والاكتمال إعدادات محفوظة وليسا تحققًا مستقلًا.',
  'Source references link this workbook to the retained report and selected account/page checks.':
    'تربط مراجع المصدر هذا المصنف بالتقرير المحفوظ وبفحوص الحساب والصفحات المحددة.',
  Platform: 'المنصة',
  'Account ID': 'معرّف الحساب',
  'Campaign ID': 'معرّف الحملة',
  'Parent campaign ID': 'معرّف الحملة الأصلية',
  Campaign: 'الحملة',
  Objective: 'الهدف',
  Currency: 'العملة',
  Timezone: 'المنطقة الزمنية',
  'Date from': 'تاريخ البداية',
  'Date to': 'تاريخ النهاية',
  Attribution: 'الإسناد',
  'Primary result': 'النتيجة الأساسية',
  Complete: 'مكتمل',
  Incomplete: 'غير مكتمل',
  Connection: 'الاتصال',
  Status: 'الحالة',
  Rows: 'الصفوف',
  'Error code': 'رمز الخطأ',
  'Warning count': 'عدد التنبيهات',
  'Query fingerprint': 'بصمة الاستعلام',
  Document: 'المستند',
  Part: 'الجزء',
  'JSON text': 'نص JSON',
  Recommendation: 'التوصية',
  Reason: 'السبب',
  'Recommendation basis': 'أساس التوصية',
  'Captured at': 'وقت الالتقاط',
  'Report ID': 'معرّف التقرير',
  'Report state': 'حالة التقرير',
  'Source status JSON': 'حالة المصدر بصيغة JSON',
  'Source quality JSON': 'جودة المصدر بصيغة JSON',
  'Formula version': 'إصدار الصيغة',
  'Formula fingerprint': 'بصمة الصيغة',
  'Retained reporting snapshot': 'نسخة تقرير محفوظة',
  'AMCP REPORT': 'تقرير AMCP',
  'PARTIAL SNAPSHOT': 'نسخة جزئية',
  'COMPLETE SNAPSHOT': 'نسخة مكتملة',
  'source rows': 'صفوف المصدر',
  Collected: 'جُمع في',
  Unknown: 'غير معروف',
  'Account and measurement summaries': 'ملخصات الحسابات والقياس',
  Result: 'النتيجة',
  Spend: 'الإنفاق',
  Impressions: 'مرات الظهور',
  Clicks: 'النقرات',
  Conversions: 'التحويلات',
  'Source error': 'خطأ المصدر',
  'Reading this report': 'كيفية قراءة هذا التقرير',
  Snapshot: 'النسخة',
  rows: 'صفوف',
  'Each account, currency, timezone, result definition, attribution and period remains separate. Blank metrics are unknown.':
    'يبقى كل حساب وعملة ومنطقة زمنية وتعريف للنتائج وإسناد وفترة منفصلًا. المقاييس الفارغة غير معروفة.',
  'Evidence sheet column C contains ordered chunks of the complete source-evidence JSON. Join them without separators.':
    'يحتوي العمود C في ورقة الأدلة على أجزاء مرتبة من أدلة المصدر الكاملة بصيغة JSON. اجمعها دون فواصل.',
  'These are retained snapshot values, including already-calculated ratios; editing rows does not recalculate the saved summaries.':
    'هذه قيم النسخة المحفوظة، بما فيها النسب المحسوبة سابقًا؛ تعديل الصفوف لا يعيد حساب الملخصات المحفوظة.',
  'Partial evidence: some sources or periods are incomplete. Review coverage before interpreting results.':
    'أدلة جزئية: بعض المصادر أو الفترات غير مكتملة. راجع التغطية قبل تفسير النتائج.',
  'Groups retain their own currency, timezone, attribution, conversion definition and reporting period. Missing values remain unknown.':
    'تحتفظ كل مجموعة بعملتها ومنطقتها الزمنية وإسنادها وتعريف التحويل وفترة التقرير الخاصة بها. تبقى القيم المفقودة غير معروفة.',
  'Account currencies, timezones, attribution and conversion definitions remain separate.':
    'تبقى عملات الحسابات ومناطقها الزمنية وتعريفات الإسناد والتحويل منفصلة.',
  'Reach and frequency are not summed. Calculated ratios come from compatible additive totals.':
    'لا يُجمع الوصول أو التكرار. تُحسب النسب من إجماليات متوافقة قابلة للجمع.',
  'Results shown as mapped are chosen by AMCP from the platform’s reported fields; they are not read from a result column of the platform’s own.':
    'النتائج المعروضة على أنها معيّنة تختارها AMCP من الحقول التي تُبلغ عنها المنصة؛ ولا تُقرأ من عمود نتائج خاص بالمنصة نفسها.',
  'Recommendations are advisory; a separate review is required for advertising changes.':
    'التوصيات إرشادية؛ وتتطلب تغييرات الإعلانات مراجعة منفصلة.',
  'Recommendations in this snapshot have expired. Refresh the report before acting on them.':
    'انتهت صلاحية التوصيات في هذه النسخة. حدّث التقرير قبل العمل بها.',
  'Full source evidence is embedded as source-evidence.json. Campaign rows are available in the Excel and CSV downloads.':
    'أدلة المصدر الكاملة مرفقة في source-evidence.json. تتوفر صفوف الحملات في تنزيلات Excel وCSV.',
  'Complete source evidence for this retained snapshot': 'أدلة المصدر الكاملة لهذه النسخة المحفوظة',
  // Charts (V2-EXP-01): the words of src/report-chart-spec.ts, the same Arabic as the website's catalogue
  // (tests/report-charts-messages.test.mjs keeps the two equal). Names from a provider are never in this list.
  'Key figures': 'المؤشرات الرئيسية',
  'Spend over time': 'الإنفاق عبر الزمن',
  'Results over time': 'النتائج عبر الزمن',
  'Spend by platform': 'الإنفاق حسب المنصة',
  'Spend by campaign': 'الإنفاق حسب الحملة',
  'Spend by ad set or ad group': 'الإنفاق حسب مجموعة الإعلانات',
  'Spend by ad': 'الإنفاق حسب الإعلان',
  'Cost per result against target': 'التكلفة لكل نتيجة مقابل المستهدف',
  'Spend by objective': 'الإنفاق حسب الهدف',
  'Top ads by result': 'أفضل الإعلانات حسب النتائج',
  'Spend and results over time': 'الإنفاق والنتائج عبر الزمن',
  'Spend by platform and by campaign': 'الإنفاق حسب المنصة وحسب الحملة',
  'Spend was highest in the period starting {date}: {value}.':
    'بلغ الإنفاق أعلى مستوى له في الفترة التي تبدأ في {date}: {value}.',
  'Results were highest in the period starting {date}: {value}.':
    'بلغت النتائج أعلى مستوى لها في الفترة التي تبدأ في {date}: {value}.',
  'The largest share of spend is {name}: {share} of {total}.': 'أكبر حصة من الإنفاق لـ {name}: {share} من {total}.',
  'Campaigns at or under their target cost per result: {count} of {total}.':
    'الحملات التي لا تتجاوز تكلفة النتيجة فيها المستهدف: {count} من {total}.',
  'The ad with the most results is {name}: {value}.': 'الإعلان الأكثر نتائج هو {name}: {value}.',
  Results: 'النتائج',
  'Cost per result': 'التكلفة لكل نتيجة',
  Target: 'القيمة المستهدفة',
  Total: 'الإجمالي',
  Other: 'أخرى',
  'Share of spend': 'حصة الإنفاق',
  'Ad set or ad group': 'مجموعة الإعلانات',
  Metric: 'المقياس',
  Value: 'القيمة',
  'Against target': 'مقارنة بالمستهدف',
  'At or under target': 'ضمن المستهدف أو أقل منه',
  'Over target': 'أعلى من المستهدف',
  'Rows with a value': 'الصفوف التي لها قيمة',
  Awareness: 'الوعي',
  Traffic: 'الزيارات',
  Engagement: 'التفاعل',
  'Video views': 'مشاهدات الفيديو',
  Leads: 'العملاء المحتملون',
  Sales: 'المبيعات',
  'App installs': 'تثبيتات التطبيق',
  'Each currency has its own chart ({currencies}). Amounts in different currencies are never combined.':
    'لكل عملة مخطط خاص بها ({currencies}). لا تُجمع المبالغ بعملات مختلفة أبدًا.',
  'Each result definition has its own chart ({definitions}). Different results are never added.':
    'لكل تعريف للنتائج مخطط خاص به ({definitions}). لا تُجمع النتائج المختلفة أبدًا.',
  'This report is partial: totals leave out the sources or periods that are missing.':
    'هذا التقرير جزئي: تستثني الإجماليات المصادر أو الفترات المفقودة.',
  'Values below zero cannot be drawn from a zero baseline. The table has them.':
    'لا يمكن رسم القيم الأقل من الصفر انطلاقًا من خط الأساس صفر. تجدها في الجدول.',
  'Amounts without a known currency are not charted.': 'لا تُرسم المبالغ التي لا تُعرف عملتها.',
  'A trend needs at least two periods; this report has {count}.':
    'يتطلب الاتجاه فترتين على الأقل؛ وفي هذا التقرير: {count}.',
  'No campaign has a cost per result target, so there is nothing to compare costs with.':
    'لا توجد حملة لها مستهدف لتكلفة النتيجة، فلا يوجد ما تُقارن به التكاليف.',
  'This report has no ad-level rows.': 'لا يتضمن هذا التقرير صفوفًا على مستوى الإعلان.',
  'All spend is on one objective, so there is nothing to compare.': 'كل الإنفاق على هدف واحد، فلا يوجد ما يُقارن.',
  'There is only one entry, so there is nothing to compare. The table has it.':
    'يوجد بند واحد فقط، فلا يوجد ما يُقارن. تجده في الجدول.',
  'No value is known, so there is nothing to draw.': 'لا توجد قيمة معروفة، فلا يوجد ما يُرسم.',
  'The smaller entries are combined as Other: {count}.': 'تُجمع البنود الأصغر تحت «أخرى»: {count}.',
  'Hollow marks are periods calculated from some of their rows only: {count}.':
    'العلامات المفرغة فترات حُسبت من بعض صفوفها فقط: {count}.',
  'The change compares the campaigns and ads that appear in both periods.':
    'يقارن التغيير الحملات والإعلانات الموجودة في الفترتين.',
  'Rows with no single result definition are left out of this chart: {count}.':
    'تُستبعد من هذا المخطط الصفوف التي ليس لها تعريف واحد للنتائج: {count}.',
  'Only the first {count} groups are charted. The report table has the rest.':
    'تُرسم أول {count} مجموعات فقط. تجد الباقي في جدول التقرير.',
};
// Only authored result definitions; native and custom result words stay literal.
const resultLabels: Record<string, string> = {
  Mixed: 'مختلط',
  'LinkedIn members reached (not additive)': 'أعضاء LinkedIn الذين تم الوصول إليهم (لا يُجمع)',
  'LinkedIn landing page clicks': 'نقرات صفحة الوصول على LinkedIn',
  'Clicks (engagement result not in the API)': 'النقرات (نتيجة التفاعل غير متاحة في واجهة API)',
  'LinkedIn video views': 'مشاهدات الفيديو على LinkedIn',
  'LinkedIn leads (one-click)': 'العملاء المحتملون على LinkedIn (بنقرة واحدة)',
  'LinkedIn website conversions': 'تحويلات الموقع على LinkedIn',
  'LinkedIn talent leads': 'العملاء المحتملون للتوظيف على LinkedIn',
};
const metricLabels: Record<string, string> = {
  spend: 'الإنفاق',
  impressions: 'مرات الظهور',
  clicks: 'النقرات',
  conversions: 'التحويلات',
  conversion_value: 'قيمة التحويل',
  cpa: 'تكلفة التحويل',
  cpc: 'تكلفة النقرة',
  cpm: 'تكلفة ألف ظهور',
  ctr: 'نسبة النقر',
  roas: 'العائد على الإنفاق الإعلاني',
  conversion_rate: 'معدل التحويل',
  reach: 'الوصول',
  frequency: 'التكرار',
};
export function artifactLocale(presentation: JsonObject = {}) {
  const rtl = presentation.artifact_language === 'ar';
  return {
    rtl,
    language: (rtl ? 'ar' : 'en') as 'ar' | 'en',
    text: (value: string) => (rtl ? (arabic[value] ?? value) : value),
    result: (value: string) => (rtl ? (resultLabels[value] ?? value) : value),
    metric: (value: string, custom: Set<string>) =>
      rtl && !custom.has(value) && metricLabels[value] ? metricLabels[value] + ' (' + value + ')' : value,
  };
}
