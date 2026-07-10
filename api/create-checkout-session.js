// POST /api/create-checkout-session
// 前端在调用完 Supabase 的 place_order() 拿到 order_id / access_token / total_cents 之后，
// 把这几个值传给这个接口，由服务端创建 Stripe Checkout 会话并返回跳转链接。
// Stripe 密钥只存在于这里（Vercel 环境变量），永远不会出现在浏览器里。
//
// 同样改用 Web 标准 Request/Response 写法，和 stripe-webhook.js 保持一致。

import Stripe from 'stripe';
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(request) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  try {
    const body = await request.json();
    const { order_id, access_token, total_cents, email, site_url } = body || {};

    if (!order_id || !access_token || !total_cents || !email) {
      return Response.json({ error: 'missing_fields' }, { status: 400 });
    }
    if (!Number.isInteger(total_cents) || total_cents <= 0) {
      return Response.json({ error: 'invalid_amount' }, { status: 400 });
    }

    const baseUrl = site_url || process.env.PUBLIC_SITE_URL;
    if (!baseUrl) {
      return Response.json({ error: 'missing_site_url_config' }, { status: 500 });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `GlobalMart Order ${order_id}` },
            unit_amount: total_cents // Stripe 金额单位本来就是"分"，和我们数据库一致
          },
          quantity: 1
        }
      ],
      // 把订单号写进 metadata，webhook 收到支付成功事件时靠这个字段去更新对应订单
      metadata: { order_id },
      success_url: `${baseUrl}/?order_id=${encodeURIComponent(order_id)}&token=${encodeURIComponent(access_token)}&paid=1`,
      cancel_url: `${baseUrl}/?order_id=${encodeURIComponent(order_id)}&token=${encodeURIComponent(access_token)}&canceled=1`
    });

    return Response.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return Response.json({ error: 'stripe_error' }, { status: 500 });
  }
}
