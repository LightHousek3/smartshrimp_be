/**
 * Appendix I reference used for ingredient checks and search suggestions.
 * Keep official row numbers 1-30 and legacy aliases; group members retain classification sources.
 * Keyword matching supports label review and does not replace a full expert assessment.
 */
const LEGAL_BASIS = '16/2026/TT-BNNMT';
const LEGAL_SOURCE = 'https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/3/16-bnnmt-kem.pdf';
const PROHIBITED_INGREDIENTS = Object.freeze(
    [
        {
            number: 1,
            name: 'Aristolochia spp và các chế phẩm từ chúng',
            aliases: [
                'Aristolochia spp và các chế phẩm từ chúng',
                'Aristolochia',
                'aristolochic acid',
                'axit aristolochic'
            ]
        },
        { number: 2, name: 'Chloramphenicol', aliases: [ 'Chloramphenicol', 'cloramphenicol' ] },
        { number: 3, name: 'Chloroform', aliases: [ 'Chloroform', 'cloroform' ] },
        {
            number: 4,
            name: 'Chlorpromazine',
            aliases: [ 'Chlorpromazine', 'chlorpromazin', 'clorpromazine' ]
        },
        { number: 5, name: 'Colchicine', aliases: [ 'Colchicine', 'colchicin' ] },
        { number: 6, name: 'Clenbuterol', aliases: [ 'Clenbuterol' ] },
        { number: 7, name: 'Cypermethrin', aliases: [ 'Cypermethrin' ] },
        { number: 8, name: 'Ciprofloxacin', aliases: [ 'Ciprofloxacin' ] },
        {
            number: 9,
            name: 'Cysteamine',
            aliases: [ 'Cysteamine', 'cysteamin', 'cysteamine hydrochloride', 'beta mercaptoethylamine' ]
        },
        {
            number: 10,
            name: 'Các Nitroimidazole khác',
            aliases: [
                'Các Nitroimidazole khác',
                'Nitroimidazole',
                'Nitroimidazoles',
                'nitroimidazol',
                'Tinidazole',
                'Ornidazole',
                'Secnidazole',
                'Nimorazole',
                'carnidazole',
                'Dimetridazole',
                'Etanidazole',
                'Ipronidazole',
                'Metronidazole',
                'Misonidazole',
                'Ronidazole'
            ],
            isGroup: true,
            classificationSources: [
                'https://www.ncbi.nlm.nih.gov/mesh?Cmd=DetailsSearch&Db=mesh&Term=%22Nitroimidazoles%22%5BMeSH+Terms%5D',
                'https://pubchem.ncbi.nlm.nih.gov/compound/Secnidazole'
            ]
        },
        { number: 11, name: 'Deltamethrin', aliases: [ 'Deltamethrin' ] },
        {
            number: 12,
            name: 'Diethylstilbestrol (DES)',
            aliases: [ 'Diethylstilbestrol (DES)', 'Diethylstilbestrol', 'DES' ]
        },
        { number: 13, name: 'Dapsone', aliases: [ 'Dapsone' ] },
        { number: 14, name: 'Dimetridazole', aliases: [ 'Dimetridazole', 'dimetridazol' ] },
        { number: 15, name: 'Enrofloxacin', aliases: [ 'Enrofloxacin' ] },
        { number: 16, name: 'Ipronidazole', aliases: [ 'Ipronidazole', 'ipronidazol' ] },
        {
            number: 17,
            name: 'Green Malachite (Xanh Malachite)',
            aliases: [
                'Green Malachite (Xanh Malachite)',
                'Green Malachite',
                'Xanh Malachite',
                'Malachite Green',
                'xanh malachit',
                'leucomalachite green'
            ]
        },
        {
            number: 18,
            name: 'Gentian Violet (Crystal violet)',
            aliases: [
                'Gentian Violet (Crystal violet)',
                'Gentian Violet',
                'Crystal violet',
                'tim gentian',
                'tim tinh the'
            ]
        },
        {
            number: 19,
            name: 'Glycopeptides',
            aliases: [
                'Glycopeptides',
                'Glycopeptide',
                'glycopeptid',
                'Vancomycin',
                'Teicoplanin',
                'Telavancin',
                'Dalbavancin',
                'Oritavancin',
                'Ramoplanin'
            ],
            isGroup: true,
            classificationSources: [
                'https://www.cancer.gov/publications/dictionaries/cancer-drug/def/glycopeptide-antibiotic'
            ]
        },
        {
            number: 20,
            name: 'Nitrofuran (bao gồm cả Furazolidone)',
            aliases: [
                'Nitrofuran (bao gồm cả Furazolidone)',
                'Nitrofuran',
                'Nitrofurans',
                'Furazolidone',
                'furazolidon',
                'Furaltadone',
                'furaltadon',
                'Nitrofurazone',
                'Nitrofurantoin',
                'nifurpirinol',
                'nifuroxazide',
                'Nifursol',
                'Furagin',
                'Furylfuramide',
                'Nifuratel',
                'Nifurtimox',
                'Nitrovin'
            ],
            isGroup: true,
            classificationSources: [
                'https://www.ncbi.nlm.nih.gov/mesh/68009581',
                'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A32023R0411'
            ]
        },
        {
            number: 21,
            name: 'Nhóm Fluoroquinolones',
            aliases: [
                'Nhóm Fluoroquinolones', 'Fluoroquinolones',
                'Fluoroquinolone',       'fluoroquinolon',
                'fluorquinolon',         'Norfloxacin',
                'Ofloxacin',             'Levofloxacin',
                'Moxifloxacin',          'Pefloxacin',
                'Lomefloxacin',          'sarafloxacin',
                'danofloxacin',          'difloxacin',
                'marbofloxacin',         'orbifloxacin',
                'gatifloxacin',          'gemifloxacin',
                'Ciprofloxacin',         'Prulifloxacin',
                'Rufloxacin'
            ],
            isGroup: true,
            classificationSources: [
                'https://www.ema.europa.eu/en/medicines/human/referrals/quinolone-fluoroquinolone-containing-medicinal-products'
            ]
        },
        { number: 22, name: 'Metronidazole', aliases: [ 'Metronidazole', 'metronidazol' ] },
        {
            number: 23,
            name: 'Trichlorfon (Dipterex)',
            aliases: [ 'Trichlorfon (Dipterex)', 'Trichlorfon', 'Dipterex', 'trichlorphon' ]
        },
        { number: 24, name: 'Trifluralin', aliases: [ 'Trifluralin' ] },
        { number: 25, name: 'Ronidazole', aliases: [ 'Ronidazole', 'ronidazol' ] },
        {
            number: 26,
            name: 'Vat Yellow 1',
            aliases: [ 'Vat Yellow 1', 'flavanthrone', 'flavanthrene', 'sandothrene', 'c28h12n2o2' ]
        },
        {
            number: 27,
            name: 'Vat Yellow 2',
            aliases: [ 'Vat Yellow 2', 'Indanthrene', 'c28h14n2o2s2' ]
        },
        {
            number: 28,
            name: 'Vat Yellow 3',
            aliases: [ 'Vat Yellow 3', 'Mikethrene', 'c28h18n2o4' ]
        },
        {
            number: 29,
            name: 'Vat Yellow 4',
            aliases: [
                'Vat Yellow 4',
                'Dibenzochrysenedione',
                'Dibenzpyrenequinone',
                '7,14-Dibenzpyrenequinone',
                'c24h12o2'
            ]
        },
        {
            number: 30,
            name: 'Auramine và các dẫn xuất',
            aliases: [
                'Auramine và các dẫn xuất',
                'Auramine',
                'yellow pyoctanine',
                'glauramine',
                'auramin',
                'c17h21n3'
            ]
        }
    ].map((entry) => Object.freeze({
        ...entry,
        id: `I-${entry.number}`,
        status: 'banned',
        group: 'Danh mục cấm',
        appendix: 'I',
        sourceRow: String(entry.number),
        page: entry.number <= 26 ? 2 : 3,
        sourceText: entry.name,
        aliases: Object.freeze(entry.aliases),
        ...(entry.classificationSources ? { classificationSources: Object.freeze(entry.classificationSources) } : {}),
    })),
);

module.exports = { LEGAL_BASIS, LEGAL_SOURCE, PROHIBITED_INGREDIENTS };
