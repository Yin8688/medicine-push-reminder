// 家庭药管家 · 订阅消息定时推送（GitHub Actions 每次运行跑一遍本脚本）
//
// 流程：登录云服务专用账号 → 调 due_dose_tasks 拿"现在该提醒谁"
//      → 用 AppSecret 换微信 access_token → 逐条调订阅消息发送接口 → 回写发送结果。
//
// 幂等与安全边界都在数据库侧（见 push-worker/sql/）：
//   - due_dose_tasks 只允许 push_allowed_users 里的服务账号调用；
//   - 同一「药品×成员×时间点×当天」只返回一次，发送端网络失败不回写，下轮还会重试；
//   - 发送成功或确定失败（如用户没订阅额度）回写 report_push_result，当天不再重发。
//
// 所需环境变量（全部配置在 GitHub 仓库 Secrets 里，绝不写进代码）：
//   WB_BOT_EMAIL      云服务推送专用账号邮箱
//   WB_BOT_PASSWORD   云服务推送专用账号密码
//   WXA_APPID         小程序 AppID
//   WXA_APP_SECRET    小程序 AppSecret（公众平台「开发管理→开发设置」生成）
//   可选：
//   WXA_TEMPLATE_ID   订阅消息模板 ID（默认已填一次性订阅模板）
//   TEMPLATE_KEYS     模板关键词编号，逗号分隔（默认 thing2,thing4，以「我的模板」里实际为准）
//   MINIPROGRAM_STATE 发送状态：体验版 trial / 正式 formal（默认 trial）
//   PAGE_PATH         点击通知进入的页面（默认 pages/index/index）
//
// 当前模板（服药计划提醒）：
//   thing2 = 药品名称；thing4 = 温馨提示；「场景说明」是固定文案，不填。

const ENDPOINT = 'https://mp-api.app.workbuddy.host';
const PUBLISHABLE_KEY = 'wbpk_jiyN7Ah5RvJITnDKtWcxz2_kVlt1CzTzjsVknkXPJQa4EvuR13MUcZy';
const DEFAULT_TEMPLATE_ID = 'SPxlImhloAiMeIRAN6JbT1CUAXZSIfxs4v2VOEsfeOY';

const env = process.env;
const required = ['WB_BOT_EMAIL', 'WB_BOT_PASSWORD', 'WXA_APPID', 'WXA_APP_SECRET'];
for (const name of required) {
    if (!env[name]) {
        console.error('缺少必需的 Secrets：' + name);
        process.exit(1);
    }
}

const BOT_EMAIL = env.WB_BOT_EMAIL;
const BOT_PASSWORD = env.WB_BOT_PASSWORD;
const WXA_APPID = env.WXA_APPID;
const WXA_APP_SECRET = env.WXA_APP_SECRET;
const TEMPLATE_ID = env.WXA_TEMPLATE_ID || DEFAULT_TEMPLATE_ID;
const TEMPLATE_KEYS = (env.TEMPLATE_KEYS || 'thing2,thing4').split(',').map(s => s.trim()).filter(Boolean);
const MINIPROGRAM_STATE = env.MINIPROGRAM_STATE || 'trial';
const PAGE_PATH = env.PAGE_PATH || 'pages/index/index';
const WINDOW_MINUTES = Number(env.WINDOW_MINUTES || 35);

// 北京时间当天，YYYY-MM-DD。不能 toISOString()，那会按 UTC 差一天。
function beijingDate() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

async function jsonFetch(url, options) {
    const res = await fetch(url, options);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { ok: res.ok, status: res.status, body };
}

// ---- 第 1 步：登录云服务专用账号 ----
async function signIn() {
    const res = await jsonFetch(ENDPOINT + '/.cloud/auth/v1/signin', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-wb-webapp-access-key': PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ username: BOT_EMAIL, password: BOT_PASSWORD }),
    });
    if (!res.ok) {
        throw new Error('云服务登录失败 HTTP ' + res.status + '：' + JSON.stringify(res.body).slice(0, 300));
    }
    const b = res.body || {};
    const token = b.access_token || (b.session && b.session.access_token)
        || (b.data && b.data.access_token) || (b.data && b.data.session && b.data.session.access_token);
    if (!token) {
        throw new Error('云服务登录响应里没有 access_token：' + JSON.stringify(b).slice(0, 300));
    }
    return token;
}

// ---- 第 2 步：查当前该发的提醒 ----
async function fetchDueTasks(token) {
    const res = await jsonFetch(ENDPOINT + '/.cloud/database/rest/rpc/due_dose_tasks', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
            'x-wb-webapp-access-key': PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ p_window_minutes: WINDOW_MINUTES }),
    });
    if (!res.ok) {
        throw new Error('查询推送任务失败 HTTP ' + res.status + '：' + JSON.stringify(res.body).slice(0, 300));
    }
    const b = res.body;
    return Array.isArray(b) ? b : (Array.isArray(b && b.data) ? b.data : []);
}

// ---- 第 3 步：换微信接口调用凭证 ----
async function getWxaToken() {
    const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential'
        + '&appid=' + encodeURIComponent(WXA_APPID)
        + '&secret=' + encodeURIComponent(WXA_APP_SECRET);
    const res = await jsonFetch(url, { method: 'GET' });
    const b = res.body || {};
    if (!b.access_token) {
        if (Number(b.errcode) === 40164) {
            throw new Error('微信接口拒绝了该服务器的 IP（errcode 40164）。'
                + '请到公众平台「开发管理 → 开发设置 → IP白名单」把 Actions 日志里提示的 IP 加进去，'
                + '或清空白名单后重试。详情：' + JSON.stringify(b).slice(0, 300));
        }
        throw new Error('获取微信 access_token 失败：' + JSON.stringify(b).slice(0, 300));
    }
    return b.access_token;
}

// ---- 第 4 步：按模板关键词拼消息体 ----
// 当前模板「服药计划提醒」实际只有两个变量：thing2=药品名称，thing4=温馨提示；
// 「场景说明」是固定文案，不填。thing 类最多 20 字符，超了微信直接拒收。
function truncate(value, max) {
    return String(value || '').slice(0, max);
}

function buildData(task) {
    const name = String(task.medicine_name || '药品');
    const spec = String(task.spec || '');
    const data = {};
    for (const key of TEMPLATE_KEYS) {
        if (/^time/i.test(key)) {
            data[key] = { value: String(task.slot || '') };
        } else if (/^number|^amount/i.test(key)) {
            data[key] = { value: String(Number(task.quantity) || 0) };
        } else if (/^thing\s*2$/i.test(key)) {
            data[key] = { value: truncate('【' + name + (spec ? '（' + spec + '）' : '') + '】', 20) };
        } else if (/^thing\s*4$/i.test(key)) {
            data[key] = { value: truncate((task.slot || '') + ' 到点请服药，服用后请在小程序标记', 20) };
        } else {
            // 换模板后的兜底：非时间/数字字段一律填药品信息。
            data[key] = { value: truncate(name + (spec ? '（' + spec + '）' : ''), 20) };
        }
    }
    return data;
}

async function sendOne(wxaToken, task) {
    const payload = {
        touser: task.openid,
        template_id: TEMPLATE_ID,
        page: PAGE_PATH,
        miniprogram_state: MINIPROGRAM_STATE,
        lang: 'zh_CN',
        data: buildData(task),
    };
    const res = await jsonFetch('https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + wxaToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const b = res.body || {};
    // errcode 0 = 成功；43101 = 用户没订阅/额度用完；40003 = openid 无效。
    return { errcode: Number(b.errcode || 0), errmsg: String(b.errmsg || '') };
}

function isPermanentPushError(errcode) {
    // 额度用完/用户拒收/openid 失效这类重试也不会好的，当天标记失败不再试。
    return [43101, 40003, 47003, 47001].indexOf(errcode) >= 0;
}

// ---- 第 5 步：回写发送结果（幂等表） ----
async function report(token, task, sendDate, status, error) {
    await jsonFetch(ENDPOINT + '/.cloud/database/rest/rpc/report_push_result', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
            'x-wb-webapp-access-key': PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
            p_medicine_id: Number(task.medicine_id),
            p_patient_id: String(task.patient_id || ''),
            p_slot: String(task.slot || ''),
            p_send_date: sendDate,
            p_status: status,
            p_error: error || null,
        }),
    });
}

async function main() {
    const sendDate = beijingDate();
    const token = await signIn();
    const tasks = await fetchDueTasks(token);
    console.log('北京时间 ' + sendDate + '，待发提醒 ' + tasks.length + ' 条');
    if (tasks.length === 0) {
        console.log('没有到点的提醒，本轮结束。');
        return;
    }

    const wxaToken = await getWxaToken();
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const task of tasks) {
        try {
            const result = await sendOne(wxaToken, task);
            if (result.errcode === 0) {
                sent += 1;
                await report(token, task, sendDate, 'sent', null);
                console.log('已发送：' + task.medicine_name + ' ' + task.slot + ' → ' + (task.patient_name || '成员'));
            } else if (isPermanentPushError(result.errcode)) {
                failed += 1;
                await report(token, task, sendDate, 'failed', result.errcode + ' ' + result.errmsg);
                console.log('发送失败（不再重试）：' + result.errcode + ' ' + result.errmsg);
            } else {
                skipped += 1;
                console.log('临时错误，下轮重试：' + result.errcode + ' ' + result.errmsg);
            }
        } catch (err) {
            skipped += 1;
            console.log('网络异常，下轮重试：' + (err && err.message));
        }
    }
    console.log('本轮完成：成功 ' + sent + '，确定失败 ' + failed + '，待重试 ' + skipped);
    if (sent > 0 && typeof process.env.GITHUB_STEP_SUMMARY === 'string') {
        const fs = await import('node:fs');
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
            '订阅消息推送：成功 ' + sent + ' 条，失败 ' + failed + ' 条\n');
    }
}

main().catch(err => {
    console.error('推送任务失败：' + (err && err.message));
    process.exit(1);
});
