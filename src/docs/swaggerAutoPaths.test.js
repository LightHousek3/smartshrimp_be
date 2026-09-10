const { buildAutoPaths } = require('./swaggerAutoPaths');

describe('swaggerAutoPaths authentication metadata', () => {
    test('marks routes protected by preceding router.use(authenticate) as secured', () => {
        const { paths } = buildAutoPaths('/api/v1');

        expect(paths['/api/v1/admin/accounts'].get.security).toEqual([{ bearerAuth: [] }]);
        expect(paths['/api/v1/admin/accounts'].post.security).toEqual([{ bearerAuth: [] }]);
        expect(paths['/api/v1/admin/accounts/{accountId}'].get.security).toEqual([
            { bearerAuth: [] },
        ]);
        expect(
            paths['/api/v1/admin/accounts/{accountId}/resend-activation'].post.security,
        ).toEqual([{ bearerAuth: [] }]);
        expect(paths['/api/v1/admin/accounts/{accountId}/status'].patch.security).toEqual([
            { bearerAuth: [] },
        ]);
    });

    test('keeps public login route unsecured', () => {
        const { paths } = buildAutoPaths('/api/v1');

        expect(paths['/api/v1/auth/login'].post.security).toBeUndefined();
    });
});
