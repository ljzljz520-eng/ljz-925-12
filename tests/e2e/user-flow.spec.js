const { test, expect } = require('@playwright/test');
const { resetTestDatabase, execSql } = require('./test-db');
const crypto = require('crypto');

const BASE_URL = 'http://localhost:3009';
const SERVER_SECRET = 'test-secret-key-for-development-only';

// 与后端 Auth::hashKey 一致：HMAC-SHA256(卡密, server_secret)
function keyHashOf(keyPlain) {
    return crypto.createHmac('sha256', SERVER_SECRET).update(keyPlain).digest('hex');
}

// 直接修改数据库中指定卡密的状态/有效期，模拟后台管理操作
function updateKeyInDb(keyPlain, setClause) {
    execSql(`UPDATE license_key SET ${setClause} WHERE key_hash = '${keyHashOf(keyPlain)}';`);
}

test.describe('User Flow', () => {
    test.beforeEach(async ({ page }) => {
        resetTestDatabase();

        await page.goto(`${BASE_URL}/gate`);
        await page.evaluate(() => {
            localStorage.clear();
        });
    });

    test('should complete full user journey', async ({ page }) => {
        await page.goto(`${BASE_URL}/`);
        await page.waitForURL(`${BASE_URL}/gate`, { timeout: 5000 });

        await page.fill('#key', 'TEST00000001');
        await page.click('#submitBtn');
        await page.waitForURL(`${BASE_URL}/home`, { timeout: 10000 });

        await expect(page.locator('h1')).toBeVisible();

        const token = await page.evaluate(() => localStorage.getItem('token'));
        expect(token).toBeTruthy();

        await page.click('#logoutBtn');
        await page.waitForURL(`${BASE_URL}/gate`, { timeout: 5000 });

        const tokenAfterLogout = await page.evaluate(() => localStorage.getItem('token'));
        expect(tokenAfterLogout).toBeNull();
    });

    test('should show error for invalid key', async ({ page }) => {
        await page.goto(`${BASE_URL}/gate`);
        await page.fill('#key', 'INVALID00001');
        await page.click('#submitBtn');
        await page.waitForTimeout(2000);

        const errorElement = page.locator('#error');
        await expect(errorElement).toBeVisible();
        await expect(errorElement).toContainText('无效');
    });

    test('should validate key format', async ({ page }) => {
        await page.goto(`${BASE_URL}/gate`);
        await page.fill('#key', 'SHORT');
        await page.click('#submitBtn');
        await page.waitForTimeout(1000);

        const errorElement = page.locator('#error');
        await expect(errorElement).toBeVisible();
    });

    test('should auto-uppercase key input', async ({ page }) => {
        await page.goto(`${BASE_URL}/gate`);
        await page.fill('#key', 'test00000001');

        const value = await page.locator('#key').inputValue();
        expect(value).toBe('TEST00000001');
    });

    test('should handle network error gracefully', async ({ page }) => {
        await page.goto(`${BASE_URL}/gate`);

        await page.route('**/api/auth/verify-key', route => {
            route.abort('failed');
        });

        await page.fill('#key', 'TEST00000001');
        await page.click('#submitBtn');
        await page.waitForTimeout(2000);

        const errorElement = page.locator('#error');
        await expect(errorElement).toBeVisible();
    });

    test('should maintain session across page refresh', async ({ page }) => {
        await page.goto(`${BASE_URL}/gate`);
        await page.fill('#key', 'TEST00000002');
        await page.click('#submitBtn');
        await page.waitForURL(`${BASE_URL}/home`);

        await page.reload();
        await expect(page).toHaveURL(`${BASE_URL}/home`);
    });

    test('should redirect to gate if token expired', async ({ page }) => {
        await page.goto(`${BASE_URL}/gate`);
        await page.fill('#key', 'TEST00000003');
        await page.click('#submitBtn');
        await page.waitForURL(`${BASE_URL}/home`);

        await page.evaluate(() => {
            localStorage.removeItem('token');
        });

        await page.reload();
        await page.waitForURL(`${BASE_URL}/gate`, { timeout: 5000 });
    });

    test('should handle concurrent logins', async ({ browser }) => {
        const context1 = await browser.newContext();
        const context2 = await browser.newContext();
        const page1 = await context1.newPage();
        const page2 = await context2.newPage();

        await Promise.all([
            (async () => {
                await page1.goto(`${BASE_URL}/gate`);
                await page1.fill('#key', 'TEST00000004');
                await page1.click('#submitBtn');
                await page1.waitForURL(`${BASE_URL}/home`);
            })(),
            (async () => {
                await page2.goto(`${BASE_URL}/gate`);
                await page2.fill('#key', 'TEST00000004');
                await page2.click('#submitBtn');
                await page2.waitForURL(`${BASE_URL}/home`);
            })()
        ]);

        await expect(page1).toHaveURL(`${BASE_URL}/home`);
        await expect(page2).toHaveURL(`${BASE_URL}/home`);

        await context1.close();
        await context2.close();
    });

    test('should update nickname successfully', async ({ page }) => {
        await page.goto(`${BASE_URL}/gate`);
        await page.fill('#key', 'TEST00000005');
        await page.click('#submitBtn');
        await page.waitForURL(`${BASE_URL}/home`);

        const nicknameInput = page.locator('#nicknameInput');
        if (await nicknameInput.count() > 0) {
            await nicknameInput.fill('测试用户');

            const saveBtn = page.locator('#saveNicknameBtn');
            await saveBtn.click();
            await page.waitForTimeout(1000);

            await page.reload();
            const savedNickname = await nicknameInput.inputValue();
            expect(savedNickname).toBe('测试用户');
        }
    });
});

test.describe('Realtime Key Check', () => {
    test.beforeEach(async ({ page }) => {
        resetTestDatabase();

        await page.goto(`${BASE_URL}/gate`);
        await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
        });
    });

    async function loginWithKey(page, key) {
        await page.goto(`${BASE_URL}/gate`);
        await page.fill('#key', key);
        await page.click('#submitBtn');
        await page.waitForURL(`${BASE_URL}/home`, { timeout: 10000 });
    }

    test('should kick user to gate with reason when key is banned', async ({ page }) => {
        await loginWithKey(page, 'TEST00000006');

        // 模拟后台封禁当前卡密
        updateKeyInDb('TEST00000006', "status = 'banned'");

        // 刷新触发实时检测（进入内容页会立即确认一次卡密状态）
        await page.reload();
        await page.waitForURL(`${BASE_URL}/gate`, { timeout: 10000 });

        // 输入页展示封禁原因
        const errorElement = page.locator('#error');
        await expect(errorElement).toBeVisible();
        await expect(errorElement).toContainText('封禁');

        // 登录状态已清除
        const token = await page.evaluate(() => localStorage.getItem('token'));
        expect(token).toBeNull();
    });

    test('should kick user to gate with reason when key is deleted', async ({ page }) => {
        await loginWithKey(page, 'TEST00000007');

        // 模拟后台删除当前卡密
        updateKeyInDb('TEST00000007', "status = 'deleted'");

        await page.reload();
        await page.waitForURL(`${BASE_URL}/gate`, { timeout: 10000 });

        const errorElement = page.locator('#error');
        await expect(errorElement).toBeVisible();
        await expect(errorElement).toContainText('删除');
    });

    test('should kick user to gate with reason when key is expired', async ({ page }) => {
        await loginWithKey(page, 'TEST00000008');

        // 模拟卡密已过期
        updateKeyInDb('TEST00000008', "expire_at = datetime('now', '-1 days', 'localtime')");

        await page.reload();
        await page.waitForURL(`${BASE_URL}/gate`, { timeout: 10000 });

        const errorElement = page.locator('#error');
        await expect(errorElement).toBeVisible();
        await expect(errorElement).toContainText('过期');
    });

    test('should not kick user on temporary network failure', async ({ page }) => {
        await loginWithKey(page, 'TEST00000009');

        // 模拟心跳接口网络中断
        await page.route('**/api/auth/ping', route => route.abort('failed'));
        await page.reload();

        // 提示网络异常重试（toast会自动消失，需及时断言）
        await expect(page.locator('#toastContainer')).toContainText('网络', { timeout: 5000 });

        // 网络失败不踢出：仍在内容页，token保留
        await page.waitForTimeout(2000);
        await expect(page).toHaveURL(`${BASE_URL}/home`);
        const token = await page.evaluate(() => localStorage.getItem('token'));
        expect(token).toBeTruthy();

        // 网络恢复后仍停留在内容页，不会被误踢
        await page.unroute('**/api/auth/ping');
        await page.reload();
        await page.waitForTimeout(1000);
        await expect(page).toHaveURL(`${BASE_URL}/home`);
    });

    test('should not show kick reason on normal gate visit', async ({ page }) => {
        await page.goto(`${BASE_URL}/gate`);

        // 正常访问输入页时不显示退出原因
        const errorElement = page.locator('#error');
        await expect(errorElement).toBeHidden();
    });
});
