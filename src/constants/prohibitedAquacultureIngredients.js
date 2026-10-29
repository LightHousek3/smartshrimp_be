/**
 * Appendix I of Circular 16/2026/TT-BNNMT, effective March 9, 2026.
 * Keep official entry numbers 1-30; aliases include members of prohibited groups.
 * Keyword matching supports label review and does not replace a full expert assessment.
 */
const LEGAL_BASIS = '16/2026/TT-BNNMT';
const LEGAL_SOURCE =
    'https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/3/16-bnnmt-kem.pdf';
const PROHIBITED_INGREDIENTS = Object.freeze(
    [
        [
            'Aristolochia',
            ['aristolochia', 'aristolochic acid', 'axit aristolochic'],
        ],
        ['Chloramphenicol', ['chloramphenicol', 'cloramphenicol']],
        ['Chloroform', ['chloroform', 'cloroform']],
        [
            'Chlorpromazine',
            ['chlorpromazine', 'chlorpromazin', 'clorpromazine'],
        ],
        ['Colchicine', ['colchicine', 'colchicin']],
        ['Clenbuterol', ['clenbuterol']],
        ['Cypermethrin', ['cypermethrin']],
        ['Ciprofloxacin', ['ciprofloxacin']],
        [
            'Cysteamine',
            [
                'cysteamine',
                'cysteamin',
                'cysteamine hydrochloride',
                'beta mercaptoethylamine',
            ],
        ],
        [
            'Nitroimidazole',
            [
                'nitroimidazole',
                'nitroimidazoles',
                'nitroimidazol',
                'tinidazole',
                'ornidazole',
                'secnidazole',
                'nimorazole',
                'carnidazole',
            ],
        ],
        ['Deltamethrin', ['deltamethrin']],
        ['Diethylstilbestrol', ['diethylstilbestrol', 'des']],
        ['Dapsone', ['dapsone']],
        ['Dimetridazole', ['dimetridazole', 'dimetridazol']],
        ['Enrofloxacin', ['enrofloxacin']],
        ['Ipronidazole', ['ipronidazole', 'ipronidazol']],
        [
            'Green Malachite',
            [
                'green malachite',
                'malachite green',
                'xanh malachite',
                'xanh malachit',
                'leucomalachite green',
            ],
        ],
        [
            'Gentian Violet',
            ['gentian violet', 'crystal violet', 'tim gentian', 'tim tinh the'],
        ],
        [
            'Glycopeptides',
            [
                'glycopeptides',
                'glycopeptide',
                'glycopeptid',
                'vancomycin',
                'teicoplanin',
                'telavancin',
                'dalbavancin',
                'oritavancin',
            ],
        ],
        [
            'Nitrofuran',
            [
                'nitrofuran',
                'nitrofurans',
                'furazolidone',
                'furazolidon',
                'furaltadone',
                'furaltadon',
                'nitrofurazone',
                'nitrofurantoin',
                'nifurpirinol',
                'nifuroxazide',
                'nifursol',
            ],
        ],
        [
            'Fluoroquinolones',
            [
                'fluoroquinolones',
                'fluoroquinolone',
                'fluoroquinolon',
                'fluorquinolon',
                'norfloxacin',
                'ofloxacin',
                'levofloxacin',
                'moxifloxacin',
                'pefloxacin',
                'lomefloxacin',
                'sarafloxacin',
                'danofloxacin',
                'difloxacin',
                'marbofloxacin',
                'orbifloxacin',
                'gatifloxacin',
                'gemifloxacin',
            ],
        ],
        ['Metronidazole', ['metronidazole', 'metronidazol']],
        ['Trichlorfon', ['trichlorfon', 'trichlorphon', 'dipterex']],
        ['Trifluralin', ['trifluralin']],
        ['Ronidazole', ['ronidazole', 'ronidazol']],
        [
            'Vat Yellow 1',
            [
                'vat yellow 1',
                'vat yellow1',
                'flavanthrone',
                'flavanthrene',
                'sandothrene',
                'c28h12n2o2',
            ],
        ],
        [
            'Vat Yellow 2',
            ['vat yellow 2', 'vat yellow2', 'indanthrene', 'c28h14n2o2s2'],
        ],
        [
            'Vat Yellow 3',
            ['vat yellow 3', 'vat yellow3', 'mikethrene', 'c28h18n2o4'],
        ],
        [
            'Vat Yellow 4',
            [
                'vat yellow 4',
                'vat yellow4',
                'dibenzochrysenedione',
                'dibenzpyrenequinone',
                'c24h12o2',
            ],
        ],
        [
            'Auramine',
            [
                'auramine',
                'auramin',
                'yellow pyoctanine',
                'glauramine',
                'c17h21n3',
            ],
        ],
    ].map(([name, aliases], index) =>
        Object.freeze({
            number: index + 1,
            name,
            aliases: Object.freeze(aliases),
        })
    )
);
module.exports = { LEGAL_BASIS, LEGAL_SOURCE, PROHIBITED_INGREDIENTS };
