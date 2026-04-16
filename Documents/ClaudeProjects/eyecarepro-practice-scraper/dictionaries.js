/**
 * EyeCarePro Practice Intelligence — Detection Dictionaries
 *
 * Curated keyword banks for identifying eye-care-specific signals
 * from scraped website content. Each dictionary is used by the
 * main scraper to classify and score practice attributes.
 */

// ─── MARKETING VENDORS ─────────────────────────────────────────────
// Detected from footer credits, meta tags, script sources, or page comments
const VENDORS = [
    { id: 'glacial', name: 'Glacial Multimedia', patterns: ['glacial multimedia', 'glacialmultimedia', 'glacial.com'] },
    { id: 'roya', name: 'Roya.com (iMatrix)', patterns: ['roya.com', 'imatrix', 'roya digital', 'powered by roya'] },
    { id: 'eyecarepro', name: 'EyeCarePro', patterns: ['eyecarepro', 'eyecare pro', 'eye care pro'] },
    { id: '4ecps', name: '4ECPs', patterns: ['4ecps', '4 ecps', 'four ecps'] },
    { id: 'optify', name: 'Optify', patterns: ['optify'] },
    { id: 'eyevertise', name: 'Eyevertise', patterns: ['eyevertise'] },
    { id: 'doctor_multimedia', name: 'Doctor Multimedia', patterns: ['doctor multimedia', 'doctormultimedia'] },
    { id: 'officite', name: 'Officite', patterns: ['officite'] },
    { id: 'myeyedr_corporate', name: 'MyEyeDr Corporate', patterns: ['myeyedr'] },
    { id: 'revoptom', name: 'RevOptom / Jobson', patterns: ['revoptom', 'jobson', 'weboptometry'] },
    { id: 'eyes_on_web', name: 'Eyes On Web', patterns: ['eyes on web', 'eyesonweb'] },
    { id: 'ecp_media', name: 'ECP Media', patterns: ['ecp media', 'ecpmedia'] },
    { id: 'practicing_eye_care', name: 'Practicing Eye Care', patterns: ['practicing eye care'] },
    { id: 'medical_web_experts', name: 'Medical Web Experts', patterns: ['medical web experts', 'medicalwebexperts'] },
    { id: 'wrs_health', name: 'WRS Health', patterns: ['wrs health'] },
    { id: 'etna_interactive', name: 'Etna Interactive', patterns: ['etna interactive'] },
    { id: 'incredible_marketing', name: 'Incredible Marketing', patterns: ['incredible marketing'] },
    { id: 'md_internet_marketing', name: 'MD Internet Marketing', patterns: ['md internet marketing'] },
    { id: 'wright_media', name: 'Wright Media', patterns: ['wright media'] },
];

// ─── CMS / WEBSITE PLATFORMS ────────────────────────────────────────
const CMS_SIGNALS = [
    { id: 'wordpress', name: 'WordPress', patterns: ['wp-content', 'wp-includes', 'wp-json', 'wordpress', '/wp-admin'], scriptPatterns: ['wp-emoji', 'wp-embed'] },
    { id: 'wix', name: 'Wix', patterns: ['wix.com', '_wix_browser_sess', 'X-Wix'], scriptPatterns: ['static.wixstatic.com', 'parastorage.com'] },
    { id: 'squarespace', name: 'Squarespace', patterns: ['squarespace', 'sqsp.net'], scriptPatterns: ['squarespace.com', 'sqsp.net'] },
    { id: 'webflow', name: 'Webflow', patterns: ['webflow.com', 'wf-cdn'], scriptPatterns: ['webflow.js'] },
    { id: 'shopify', name: 'Shopify', patterns: ['shopify.com', 'myshopify', 'cdn.shopify'], scriptPatterns: ['cdn.shopify.com'] },
    { id: 'weebly', name: 'Weebly', patterns: ['weebly.com'], scriptPatterns: ['editmysite.com'] },
    { id: 'godaddy', name: 'GoDaddy Website Builder', patterns: ['godaddy.com', 'secureserver.net', 'wsimg.com'], scriptPatterns: ['img1.wsimg.com'] },
    { id: 'duda', name: 'Duda', patterns: ['duda.co', 'dudaone'], scriptPatterns: ['cdn-cms.f-static.com'] },
    { id: 'joomla', name: 'Joomla', patterns: ['/media/jui/', '/media/system/', 'joomla'], scriptPatterns: ['joomla.js'] },
    { id: 'drupal', name: 'Drupal', patterns: ['drupal.org', 'drupal.js', '/sites/default/'], scriptPatterns: ['drupal.js'] },
    { id: 'hubspot_cms', name: 'HubSpot CMS', patterns: ['hubspot.com', 'hs-scripts', 'hbspt'], scriptPatterns: ['js.hs-scripts.com', 'js.hsforms.net'] },
];

// ─── SCHEDULING PLATFORMS ───────────────────────────────────────────
const SCHEDULING_PLATFORMS = [
    // ── Eye-care-specific schedulers (highest priority) ──
    { id: 'localmed', name: 'LocalMed', patterns: ['localmed.com', 'localmed'] },
    { id: 'scheduleyourexam', name: 'ScheduleYourExam (Crystal PM)', patterns: ['scheduleyourexam.com', 'scheduleyourexam', 'schedule your exam'] },
    { id: 'revolution_ehr_scheduler', name: 'RevolutionEHR Scheduler', patterns: ['revolutionehr.com/scheduling', 'revehrscheduler', 'rev-scheduler', 'revolutionehr.com/book', 'revolutionehr.*schedul'] },
    { id: 'eyefinity_scheduler', name: 'Eyefinity Scheduler', patterns: ['eyefinity.com/scheduling', 'eyefinity.*schedul', 'eyefinity.*book', 'eyefinityscheduler'] },
    { id: 'optikal', name: 'Optikal', patterns: ['optikal'] },
    { id: 'visualbook', name: 'VisualBook', patterns: ['visualbook.ca', 'visualbook.com', 'visualbook'] },

    // ── General healthcare / practice schedulers ──
    { id: 'zocdoc', name: 'Zocdoc', patterns: ['zocdoc.com', 'zocdoc'] },
    { id: 'nexhealth', name: 'NexHealth', patterns: ['nexhealth.com', 'nexhealth'] },
    { id: 'luma_health', name: 'Luma Health', patterns: ['lumahealth.io', 'lumahealth.com', 'luma health', 'lumahealth'] },
    { id: 'tebra', name: 'Tebra', patterns: ['tebra.com', 'tebra', 'kareo.*schedul'] },
    { id: 'weave', name: 'Weave', patterns: ['getweave.com', 'weave.com', 'weave'] },
    { id: 'doctor_connect', name: 'DoctorConnect', patterns: ['doctorconnect.net', 'doctorconnect.com', 'doctorconnect'] },
    { id: 'solutionreach', name: 'Solutionreach', patterns: ['solutionreach.com', 'solutionreach', 'smilereminder'] },
    { id: 'patient_pop', name: 'PatientPop', patterns: ['patientpop.com', 'patientpop'] },
    { id: 'klara', name: 'Klara', patterns: ['klara.com', 'klara'] },
    { id: 'doctible', name: 'Doctible', patterns: ['doctible.com', 'doctible'] },
    { id: 'simplepractice', name: 'SimplePractice', patterns: ['simplepractice.com', 'simplepractice'] },
    { id: 'practiceq', name: 'PracticeQ / IntakeQ', patterns: ['practiceq.com', 'intakeq.com', 'practiceq', 'intakeq'] },
    { id: 'healthie', name: 'Healthie', patterns: ['healthie.com'] },

    // ── General-purpose schedulers ──
    { id: 'acuity', name: 'Acuity Scheduling', patterns: ['acuityscheduling.com', 'acuity-scheduling', 'app.acuityscheduling'] },
    { id: 'calendly', name: 'Calendly', patterns: ['calendly.com'] },
    { id: 'cal_com', name: 'Cal.com', patterns: ['cal.com/'] },

    // ── Low-priority / often legacy (deprioritized) ──
    { id: 'demand_force', name: 'Demandforce', patterns: ['demandforce.com', 'demandforce'], priority: 'low' },
];

// ─── EHR / PMS SYSTEMS ─────────────────────────────────────────────
const EHR_PMS = [
    { id: 'crystal_pm', name: 'Crystal PM', patterns: ['crystal pm', 'crystalpm'] },
    { id: 'revolution_ehr', name: 'RevolutionEHR', patterns: ['revolutionehr', 'revolution ehr'] },
    { id: 'compulink', name: 'Compulink', patterns: ['compulink', 'eyecloud'] },
    { id: 'eyefinity', name: 'Eyefinity / VSP', patterns: ['eyefinity', 'officemate'] },
    { id: 'nextech', name: 'Nextech', patterns: ['nextech', 'nextech.com'] },
    { id: 'modernizing_medicine', name: 'ModMed (Modernizing Medicine)', patterns: ['modernizing medicine', 'modmed', 'ema ophth'] },
    { id: 'athena', name: 'athenahealth', patterns: ['athenahealth', 'athenanet', 'athena.io'] },
    { id: 'epic', name: 'Epic / MyChart', patterns: ['mychart', 'epic.com', 'epicweb'] },
    { id: 'drchrono', name: 'DrChrono', patterns: ['drchrono'] },
    { id: 'webpt', name: 'WebPT', patterns: ['webpt.com'] },
    { id: 'elation', name: 'Elation Health', patterns: ['elationhealth', 'elation health'] },
    { id: 'practice_fusion', name: 'Practice Fusion', patterns: ['practicefusion'] },
    { id: 'maximeyes', name: 'MaximEyes', patterns: ['maximeyes'] },
    { id: 'ocuco', name: 'Ocuco', patterns: ['ocuco'] },
    { id: 'liquid_ehr', name: 'Liquid EHR', patterns: ['liquid ehr', 'liquidehr'] },
];

// ─── EYE CARE SERVICES TAXONOMY ─────────────────────────────────────
const SERVICES = {
    // Optometry core
    comprehensive_exam: { label: 'Comprehensive Eye Exams', patterns: ['comprehensive eye exam', 'eye exam', 'annual eye exam', 'routine eye exam', 'vision exam', 'eye health exam'], category: 'optometry' },
    pediatric: { label: 'Pediatric Eye Care', patterns: ['pediatric', 'children.*eye', 'kids.*vision', 'infant.*eye', 'child.*eye care', 'pediatric optometry'], category: 'optometry' },
    contact_lens: { label: 'Contact Lens Fitting', patterns: ['contact lens', 'contacts fitting', 'contact lens exam', 'specialty contacts', 'scleral lens', 'hard.*contact', 'rgp', 'soft contact'], category: 'optometry' },
    vision_therapy: { label: 'Vision Therapy', patterns: ['vision therapy', 'orthoptics', 'binocular vision', 'convergence insufficiency', 'vision training'], category: 'optometry' },
    low_vision: { label: 'Low Vision Services', patterns: ['low vision', 'low-vision', 'visual impairment', 'vision rehabilitation'], category: 'optometry' },
    myopia_management: { label: 'Myopia Management', patterns: ['myopia management', 'myopia control', 'ortho-k', 'orthokeratology', 'atropine.*myopia', 'misight', 'brilliant futures', 'stellest'], category: 'specialty' },

    // Dry eye
    dry_eye: { label: 'Dry Eye Treatment', patterns: ['dry eye', 'dry-eye', 'meibomian', 'mgd', 'blepharitis', 'ocular surface'], category: 'specialty' },
    optilight: { label: 'OptiLight / IPL', patterns: ['optilight', 'ipl.*dry', 'intense pulsed light.*eye', 'lumenis'], category: 'specialty' },
    lipiflow: { label: 'LipiFlow', patterns: ['lipiflow', 'lipi-flow', 'tearscience', 'thermal pulsation'], category: 'specialty' },
    tearlab: { label: 'TearLab', patterns: ['tearlab', 'tear lab', 'osmolarity test'], category: 'specialty' },
    iLux: { label: 'iLux', patterns: ['ilux', 'i-lux'], category: 'specialty' },
    zest: { label: 'ZEST', patterns: ['zest.*blepharitis', 'zocular', 'zest treatment'], category: 'specialty' },
    blephex: { label: 'BlephEx', patterns: ['blephex'], category: 'specialty' },

    // Surgical — Refractive
    lasik: { label: 'LASIK', patterns: ['lasik', 'laser.*vision.*correction', 'ilasik', 'bladeless lasik', 'blade-free lasik', 'custom lasik', 'wavefront lasik'], category: 'surgical' },
    prk: { label: 'PRK', patterns: ['\\bprk\\b', 'photorefractive keratectomy'], category: 'surgical' },
    smile: { label: 'SMILE', patterns: ['\\bsmile\\b.*laser', 'small incision lenticule'], category: 'surgical' },
    icl: { label: 'ICL / Implantable Lens', patterns: ['\\bicl\\b', 'implantable collamer', 'implantable contact lens', 'evo icl', 'visian icl'], category: 'surgical' },
    rle: { label: 'Refractive Lens Exchange', patterns: ['refractive lens exchange', '\\brle\\b', 'clear lens exchange'], category: 'surgical' },

    // Surgical — Cataract
    cataract: { label: 'Cataract Surgery', patterns: ['cataract', 'intraocular lens', '\\biol\\b', 'phacoemulsification', 'lens replacement', 'cataract removal'], category: 'surgical' },
    premium_iol: { label: 'Premium IOLs', patterns: ['premium.*iol', 'multifocal.*iol', 'toric.*iol', 'panoptix', 'vivity', 'synergy', 'symfony', 'tecnis', 'acrysof', 'light adjustable lens'], category: 'surgical' },
    laser_cataract: { label: 'Laser-Assisted Cataract', patterns: ['laser.*cataract', 'femtosecond.*cataract', 'lensx', 'catalys', 'femto.*cataract'], category: 'surgical' },

    // Surgical — Other
    glaucoma: { label: 'Glaucoma Treatment/Surgery', patterns: ['glaucoma', 'migs', 'istent', 'trabeculectomy', 'selective laser trabeculoplasty', 'slt', 'intraocular pressure', 'iop'], category: 'surgical' },
    retina: { label: 'Retina Services', patterns: ['retina', 'retinal', 'macular degeneration', 'amd', 'diabetic retinopathy', 'retinal detachment', 'vitrectomy', 'anti-vegf', 'intravitreal', 'floaters'], category: 'surgical' },
    cornea: { label: 'Cornea Services', patterns: ['cornea', 'corneal transplant', 'keratoconus', 'cross-linking', 'crosslinking', 'corneal collagen', 'pterygium'], category: 'surgical' },
    oculoplastics: { label: 'Oculoplastics', patterns: ['oculoplastic', 'blepharoplasty', 'eyelid surgery', 'ptosis', 'eyelid lift', 'cosmetic.*eyelid', 'dermal filler.*eye', 'botox.*eye'], category: 'surgical' },
    strabismus: { label: 'Strabismus Surgery', patterns: ['strabismus', 'eye muscle surgery', 'crossed eye', 'eye alignment'], category: 'surgical' },

    // Technology
    oct: { label: 'OCT Imaging', patterns: ['\\boct\\b', 'optical coherence tomography', 'oct scan', 'oct imaging'], category: 'technology' },
    optos: { label: 'Optos / Wide-Field Imaging', patterns: ['optos', 'optomap', 'wide-field', 'ultra-widefield', 'retinal imaging'], category: 'technology' },
    fundus: { label: 'Fundus Photography', patterns: ['fundus photo', 'retinal photo', 'retinal camera'], category: 'technology' },
    visual_field: { label: 'Visual Field Testing', patterns: ['visual field', 'humphrey', 'perimetry'], category: 'technology' },
    topography: { label: 'Corneal Topography', patterns: ['topograph', 'pentacam', 'keratograph', 'corneal mapping'], category: 'technology' },

    // Optical
    eyeglasses: { label: 'Eyeglasses / Frames', patterns: ['eyeglasses', 'eye glasses', 'prescription glasses', 'eyewear', 'frames', 'spectacles', 'designer frames'], category: 'optical' },
    sunglasses: { label: 'Sunglasses', patterns: ['sunglasses', 'sun glasses', 'polarized', 'prescription sunglasses'], category: 'optical' },
    lens_types: { label: 'Specialty Lenses', patterns: ['progressive', 'bifocal', 'anti-reflective', 'blue light', 'transitions', 'photochromic', 'digital lens', 'computer glasses', 'trivex'], category: 'optical' },
    sports_vision: { label: 'Sports Vision', patterns: ['sports vision', 'sports eyewear', 'athletic vision', 'sports goggles', 'performance vision'], category: 'specialty' },

    // Co-Management (OD practices that refer surgical patients)
    comanagement: { label: 'Surgical Co-Management', patterns: ['co-?management', 'comanagement', 'co-?manage', 'pre-?op', 'post-?op', 'surgical.*referral', 'we refer', 'refer.*surgeon'], category: 'optometry' },

    // Emergency
    emergency: { label: 'Emergency Eye Care', patterns: ['emergency.*eye', 'urgent.*eye', 'eye emergency', 'eye trauma', 'foreign body removal'], category: 'optometry' },
};

// ─── PREMIUM FRAME BRANDS ───────────────────────────────────────────
// Tier classification helps determine practice positioning
const FRAME_BRANDS = {
    luxury: ['tom ford', 'cartier', 'bvlgari', 'bulgari', 'chopard', 'chrome hearts', 'dita', 'jacques marie mage', 'lindberg', 'ic! berlin', 'ic berlin', 'fred', 'maybach', 'gold & wood', 'lotos', 'matsuda'],
    premium: ['gucci', 'prada', 'chanel', 'dior', 'fendi', 'versace', 'saint laurent', 'burberry', 'dolce.*gabbana', 'celine', 'tiffany', 'jimmy choo', 'bottega veneta', 'oliver peoples', 'barton perreira', 'persol', 'mykita', 'garrett leight', 'moscot', 'cutler and gross', 'face a face'],
    mainstream: ['ray-ban', 'rayban', 'ray ban', 'oakley', 'coach', 'michael kors', 'kate spade', 'marc jacobs', 'calvin klein', 'nike vision', 'under armour', 'columbia', 'lacoste', 'ralph lauren', 'armani exchange', 'emporio armani', 'vogue eyewear'],
    value: ['warby parker', 'zenni', 'eyebuydirect', 'liingo', 'pair eyewear', 'jins', 'clearly'],
    independent: ['prodesign', 'ovvo', 'modo', 'lightec', 'silhouette', 'brendel', 'woow', 'res/rei', 'etnia barcelona', 'anne et valentin', 'theo', 'bevel', 'salt optics', 'ogi', 'lafont', 'kliik'],
    kids: ['miraflex', 'nano vista', 'tomato glasses', 'dilli dalli', 'ray-ban junior', 'oakley youth'],
};

// ─── INSURANCE PROVIDERS ────────────────────────────────────────────
const INSURANCE_PROVIDERS = [
    { id: 'vsp', name: 'VSP', patterns: ['\\bvsp\\b', 'vision service plan'] },
    { id: 'eyemed', name: 'EyeMed', patterns: ['eyemed'] },
    { id: 'davis', name: 'Davis Vision', patterns: ['davis vision'] },
    { id: 'spectera', name: 'Spectera / United Healthcare', patterns: ['spectera', 'united healthcare.*vision', 'uhc.*vision'] },
    { id: 'aetna', name: 'Aetna', patterns: ['aetna'] },
    { id: 'cigna', name: 'Cigna', patterns: ['cigna'] },
    { id: 'blue_cross', name: 'Blue Cross Blue Shield', patterns: ['blue cross', 'blue shield', 'bcbs', 'bluecross'] },
    { id: 'humana', name: 'Humana', patterns: ['humana'] },
    { id: 'tricare', name: 'Tricare', patterns: ['tricare'] },
    { id: 'medicare', name: 'Medicare', patterns: ['medicare'] },
    { id: 'medicaid', name: 'Medicaid', patterns: ['medicaid'] },
    { id: 'superior', name: 'Superior Vision', patterns: ['superior vision'] },
    { id: 'avesis', name: 'Avesis', patterns: ['avesis'] },
    { id: 'march', name: 'March Vision', patterns: ['march vision'] },
    { id: 'anthem', name: 'Anthem', patterns: ['anthem'] },
    { id: 'guardian', name: 'Guardian', patterns: ['guardian.*vision', 'guardian.*dental'] },
    { id: 'united', name: 'UnitedHealthcare', patterns: ['unitedhealthcare', 'united health care', 'uhc'] },
    { id: 'block', name: 'Block Vision', patterns: ['block vision'] },
    { id: 'envolve', name: 'Envolve Vision', patterns: ['envolve'] },
    { id: 'versant', name: 'Versant Health', patterns: ['versant'] },
];

// ─── REVIEW / REPUTATION PLATFORMS ──────────────────────────────────
const REVIEW_PLATFORMS = [
    { id: 'birdeye', name: 'Birdeye', patterns: ['birdeye.com', 'birdeye'] },
    { id: 'podium', name: 'Podium', patterns: ['podium.com', 'podium'] },
    { id: 'google_reviews', name: 'Google Reviews Widget', patterns: ['elfsight.*google', 'google.*review.*widget', 'google-reviews', 'trustindex.*google'] },
    { id: 'yelp', name: 'Yelp Widget', patterns: ['yelp.com/biz', 'yelp-widget', 'yelp.*badge'] },
    { id: 'healthgrades', name: 'Healthgrades', patterns: ['healthgrades.com'] },
    { id: 'realself', name: 'RealSelf', patterns: ['realself.com'] },
    { id: 'vitals', name: 'Vitals', patterns: ['vitals.com'] },
    { id: 'ratemds', name: 'RateMDs', patterns: ['ratemds.com'] },
    { id: 'patient_engage', name: 'Patient Engage', patterns: ['patient engage', 'patientengage'] },
    { id: 'reputation_com', name: 'Reputation.com', patterns: ['reputation.com'] },
    { id: 'swell', name: 'Swell', patterns: ['swellcx.com', 'swell'] },
    { id: 'nps', name: 'Net Promoter Score', patterns: ['net promoter', '\\bnps\\b'] },
];

// ─── ACCESSIBILITY / COMPLIANCE WIDGETS ─────────────────────────────
const ACCESSIBILITY_WIDGETS = [
    { id: 'userway', name: 'UserWay', patterns: ['userway.org', 'userway'] },
    { id: 'accessibe', name: 'accessiBe', patterns: ['accessibe.com', 'accessibe', 'acsbapp.com'] },
    { id: 'equalweb', name: 'EqualWeb', patterns: ['equalweb.com', 'equalweb'] },
    { id: 'audioeye', name: 'AudioEye', patterns: ['audioeye.com', 'audioeye'] },
    { id: 'ada_compliant', name: 'ADA Compliance Notice', patterns: ['ada compliance', 'americans with disabilities', 'accessibility statement'] },
];

// ─── ANALYTICS / TRACKING ───────────────────────────────────────────
const ANALYTICS = [
    { id: 'ga4', name: 'Google Analytics 4', patterns: ['gtag.*G-', 'google.*analytics.*4', 'googletagmanager.*gtag'] },
    { id: 'ga_universal', name: 'Google Analytics (Universal)', patterns: ['UA-\\d', 'google-analytics.com/analytics.js'] },
    { id: 'gtm', name: 'Google Tag Manager', patterns: ['googletagmanager.com/gtm', 'GTM-'] },
    { id: 'facebook_pixel', name: 'Facebook Pixel', patterns: ['facebook.com/tr', 'fbevents.js', 'fbq\\('] },
    { id: 'hotjar', name: 'Hotjar', patterns: ['hotjar.com', 'hj\\('] },
    { id: 'clarity', name: 'Microsoft Clarity', patterns: ['clarity.ms'] },
    { id: 'callrail', name: 'CallRail', patterns: ['callrail.com', 'calltrk'] },
    { id: 'call_tracking_metrics', name: 'CallTrackingMetrics', patterns: ['calltrackingmetrics', 'ctm.com'] },
    { id: 'hubspot_tracking', name: 'HubSpot Tracking', patterns: ['js.hs-scripts.com', 'hs-analytics'] },
    { id: 'google_ads', name: 'Google Ads', patterns: ['googleads.g.doubleclick', 'AW-\\d', 'google_conversion'] },
    { id: 'bing_ads', name: 'Bing / Microsoft Ads', patterns: ['bat.bing.com', 'UET'] },
];

// ─── SOCIAL PLATFORMS ───────────────────────────────────────────────
const SOCIAL_PLATFORMS = [
    { id: 'facebook', name: 'Facebook', urlPattern: /(?:facebook\.com|fb\.com)\/([^\/\?"#\s]+)/i },
    { id: 'instagram', name: 'Instagram', urlPattern: /instagram\.com\/([^\/\?"#\s]+)/i },
    { id: 'twitter', name: 'X (Twitter)', urlPattern: /(?:twitter\.com|x\.com)\/([^\/\?"#\s]+)/i },
    { id: 'youtube', name: 'YouTube', urlPattern: /youtube\.com\/(?:c\/|channel\/|user\/|@)?([^\/\?"#\s]+)/i },
    { id: 'linkedin', name: 'LinkedIn', urlPattern: /linkedin\.com\/(?:company|in)\/([^\/\?"#\s]+)/i },
    { id: 'tiktok', name: 'TikTok', urlPattern: /tiktok\.com\/@?([^\/\?"#\s]+)/i },
    { id: 'pinterest', name: 'Pinterest', urlPattern: /pinterest\.com\/([^\/\?"#\s]+)/i },
    { id: 'nextdoor', name: 'Nextdoor', urlPattern: /nextdoor\.com/i },
    { id: 'yelp', name: 'Yelp', urlPattern: /yelp\.com\/biz\/([^\/\?"#\s]+)/i },
    { id: 'google_business', name: 'Google Business Profile', urlPattern: /(?:g\.page|google\.com\/maps|maps\.google\.com|goo\.gl\/maps)/i },
];

// ─── CONTACT FORM PLATFORMS ─────────────────────────────────────────
const FORM_PLATFORMS = [
    { id: 'gravity_forms', name: 'Gravity Forms', patterns: ['gform', 'gravity.*form', 'gravityforms'] },
    { id: 'wpforms', name: 'WPForms', patterns: ['wpforms', 'wp-forms'] },
    { id: 'contact_form_7', name: 'Contact Form 7', patterns: ['wpcf7', 'contact-form-7'] },
    { id: 'typeform', name: 'Typeform', patterns: ['typeform.com'] },
    { id: 'jotform', name: 'JotForm', patterns: ['jotform.com', 'jotformeu.com'] },
    { id: 'hubspot_forms', name: 'HubSpot Forms', patterns: ['hsforms.net', 'hbspt.forms'] },
    { id: 'formstack', name: 'Formstack', patterns: ['formstack.com'] },
    { id: 'cognito_forms', name: 'Cognito Forms', patterns: ['cognitoforms.com'] },
    { id: 'ninja_forms', name: 'Ninja Forms', patterns: ['ninja-forms', 'nf-form'] },
];

// ─── PAYMENT / BILLING ─────────────────────────────────────────────
const PAYMENT_SYSTEMS = [
    { id: 'instamed', name: 'InstaMed', patterns: ['instamed'] },
    { id: 'carecredit', name: 'CareCredit', patterns: ['carecredit'] },
    { id: 'alphaeon', name: 'Alphaeon Credit', patterns: ['alphaeon'] },
    { id: 'cherry', name: 'Cherry Payment Plans', patterns: ['withcherry', 'cherry.*payment', 'cherry.*financing'] },
    { id: 'sunbit', name: 'Sunbit', patterns: ['sunbit'] },
    { id: 'scratchpay', name: 'Scratchpay', patterns: ['scratchpay'] },
    { id: 'square', name: 'Square', patterns: ['squareup.com'] },
    { id: 'stripe', name: 'Stripe', patterns: ['stripe.com', 'js.stripe.com'] },
    { id: 'paypal', name: 'PayPal', patterns: ['paypal.com'] },
];

// ─── HIPAA / TELEHEALTH SIGNALS ─────────────────────────────────────
const TELEHEALTH = [
    { id: 'doxy', name: 'Doxy.me', patterns: ['doxy.me'] },
    { id: 'vsee', name: 'VSee', patterns: ['vsee.com'] },
    { id: 'zoom_health', name: 'Zoom for Healthcare', patterns: ['zoom.us.*health', 'zoom.*hipaa'] },
    { id: 'eyecare_live', name: 'EyecareLive', patterns: ['eyecarelive'] },
    { id: 'generic_telehealth', name: 'Telehealth Services', patterns: ['telehealth', 'telemedicine', 'virtual visit', 'virtual consultation', 'online consultation'] },
];

module.exports = {
    VENDORS,
    CMS_SIGNALS,
    SCHEDULING_PLATFORMS,
    EHR_PMS,
    SERVICES,
    FRAME_BRANDS,
    INSURANCE_PROVIDERS,
    REVIEW_PLATFORMS,
    ACCESSIBILITY_WIDGETS,
    ANALYTICS,
    SOCIAL_PLATFORMS,
    FORM_PLATFORMS,
    PAYMENT_SYSTEMS,
    TELEHEALTH,
};
