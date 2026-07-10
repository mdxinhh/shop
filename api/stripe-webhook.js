// POST /api/stripe-webhook
// Stripe 服务器在用户完成支付后会调用这个地址。这里做两件事：
// 1) 验证请求真的来自 Stripe（用签名密钥校验，防止别人伪造"支付成功"请求）
// 2) 用 Supabase 的 service_role key（只在服务端使用，前端永远拿不到）
//    直接把订单状态改成 paid —— 这是全站唯一能把订单标记为已支付的地方。
//
// 关键点：用 export default { async fetch(request) {...} } 这个写法。
// 这是 Vercel 官方文档里明确标注"适用于纯 /api 目录、不需要 Next.js"的 Web 标准写法，
// 用它才能保证请求体不会被平台提前解析，Stripe 签名校验才能拿到真正的原始字节。

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('method_not_allowed', { status: 405 });
    }

    const rawBody = await request.text(); // 真正未被修改过的原始请求体
    const sig = request.headers.get('stripe-signature');

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return new Response(`Webhook Error: ${err.message}`, { status: 400 });
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
      return Response.json({ received: true });
    } catch (err) {
      console.error('stripe-webhook handling error:', err);
      return new Response(JSON.stringify({ error: 'internal_error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
