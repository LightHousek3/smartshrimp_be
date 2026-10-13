jest.mock('../src/config', () => ({ rag: { workerIntervalMs: 5000 } }));
jest.mock('../src/config/logger', () => ({ error: jest.fn() }));
jest.mock('../src/services/ragDocument.service', () => ({ processNext: jest.fn() }));
const { processNext } = require('../src/services/ragDocument.service');
const worker = require('../src/services/ragDocumentWorker');

test('starts immediately, skips overlapping ticks, and stops polling', async () => {
    jest.useFakeTimers();
    let finish;
    processNext.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    try {
        worker.start();
        worker.start();
        expect(processNext).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(10000);
        expect(processNext).toHaveBeenCalledTimes(1);
        finish();
        await jest.advanceTimersByTimeAsync(5000);
        expect(processNext).toHaveBeenCalledTimes(2);
        worker.stop();
        await jest.advanceTimersByTimeAsync(10000);
        expect(processNext).toHaveBeenCalledTimes(2);
    } finally {
        worker.stop();
        jest.useRealTimers();
    }
});
