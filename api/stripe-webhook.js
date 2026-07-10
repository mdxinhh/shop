// POST /api/stripe-webhook
// Stripe 服务器在用户完成支付后会调用这个地址。这里做两件事：
// 1) 验证请求真的来自 Stripe（用签名密钥校验，防止别人伪造"支付成功"请求）
// 2) 用 Supabase 的 service_role key（只在服务端使用，前端永远拿不到）
//    直接把订单状态改成 paid —— 这是全站唯一能把订单标记为已支付的地方。

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 必须关闭 Vercel 默认的 body 解析，因为 Stripe 签名校验需要原始请求体（raw body）
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end('method_not_allowed');
    return;
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orderId = session.metadata && session.metadata.order_id;

      if (orderId) {
        const { error } = await supabaseAdmin
          .from('orders')
          .update({ status: 'paid' })
          .eq('id', orderId)
          .eq('status', 'pending'); // 只允许 pending -> paid，防止重复/乱序事件覆盖

        if (error) console.error('Supabase update error:', error);
      }
    }
    // 可选：处理 checkout.session.expired / payment_intent.payment_failed 等事件，
    // 把订单标记为 failed / canceled，这里先留空，按需扩展。

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('stripe-webhook handling error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
};
