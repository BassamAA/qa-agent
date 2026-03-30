import Stripe from 'stripe';

const stripe = new Stripe(process.env['STRIPE_SECRET_KEY'] ?? '');

export async function createCheckoutSession(priceId: string, userId: string) {
  return stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: 'subscription',
    metadata: { userId },
    success_url: `${process.env['NEXT_PUBLIC_APP_URL']}/success`,
    cancel_url: `${process.env['NEXT_PUBLIC_APP_URL']}/cancel`,
  });
}

export async function verifyWebhook(payload: string, sig: string) {
  return stripe.webhooks.constructEvent(
    payload,
    sig,
    process.env['STRIPE_WEBHOOK_SECRET'] ?? ''
  );
}
