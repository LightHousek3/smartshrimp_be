const loadCorsOptions = ({ env, origins }) => {
    jest.resetModules();
    jest.doMock('../../src/config', () => ({
        env,
        cors: { origin: origins },
    }));
    return require('../../src/config/cors');
};

const evaluateOrigin = (corsOptions, origin) =>
    new Promise((resolve) => {
        corsOptions.origin(origin, (error, allowed) => resolve({ error, allowed }));
    });

describe('CORS origin policy', () => {
    afterEach(() => {
        jest.dontMock('../../src/config');
    });

    test('allows requests without an Origin header', async () => {
        const corsOptions = loadCorsOptions({ env: 'production', origins: [] });

        await expect(evaluateOrigin(corsOptions)).resolves.toEqual({
            error: null,
            allowed: true,
        });
    });

    test.each([
        'http://localhost:62413',
        'http://127.0.0.1:5173',
        'http://[::1]:8080',
    ])('allows local Flutter Web origin %s in development', async (origin) => {
        const corsOptions = loadCorsOptions({ env: 'development', origins: [] });

        await expect(evaluateOrigin(corsOptions, origin)).resolves.toEqual({
            error: null,
            allowed: true,
        });
    });

    test('still rejects a non-local development origin outside the whitelist', async () => {
        const corsOptions = loadCorsOptions({ env: 'development', origins: [] });
        const result = await evaluateOrigin(corsOptions, 'https://untrusted.example');

        expect(result.allowed).toBeUndefined();
        expect(result.error).toEqual(new Error('Not allowed by CORS'));
    });

    test('does not allow an unlisted localhost origin in production', async () => {
        const corsOptions = loadCorsOptions({ env: 'production', origins: [] });
        const result = await evaluateOrigin(corsOptions, 'http://localhost:62413');

        expect(result.allowed).toBeUndefined();
        expect(result.error).toEqual(new Error('Not allowed by CORS'));
    });

    test('allows an explicitly configured production origin', async () => {
        const origin = 'https://app.smartshrimp.vn';
        const corsOptions = loadCorsOptions({ env: 'production', origins: [origin] });

        await expect(evaluateOrigin(corsOptions, origin)).resolves.toEqual({
            error: null,
            allowed: true,
        });
    });
});
