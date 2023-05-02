import { NextApiRequest, NextApiResponse } from "next";
import { Readable } from "node:stream";
import Stripe from "stripe";
import prisma from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { PLANS } from "@/lib/stripe/constants";
import { redis } from "@/lib/upstash";
import { log } from "@/lib/utils";

// Stripe requires the raw body to construct the event.
export const config = {
  api: {
    bodyParser: false,
  },
};

async function buffer(readable: Readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

const relevantEvents = new Set([
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

export default async function webhookHandler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  // POST /api/stripe/webhook – listen to Stripe webhooks
  if (req.method === "POST") {
    const buf = await buffer(req);
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event: Stripe.Event;
    try {
      if (!sig || !webhookSecret) return;
      event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
    } catch (err: any) {
      console.log(`❌ Error message: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    if (relevantEvents.has(event.type)) {
      try {
        if (event.type === "checkout.session.completed") {
          const checkoutSession = event.data.object as Stripe.Checkout.Session;

          // when the project subscribes to a plan, set their stripe customer ID
          // in the database for easy identification in future webhook events
          // also update the billingCycleStart to today's date

          await prisma.project.update({
            where: {
              id: checkoutSession.client_reference_id,
            },
            data: {
              stripeId: checkoutSession.customer.toString(),
              billingCycleStart: new Date().getDate(),
            },
          });
        } else if (event.type === "customer.subscription.updated") {
          const subscriptionUpdated = event.data.object as Stripe.Subscription;
          const newPriceId = subscriptionUpdated.items.data[0].price.id;
          const env =
            process.env.NEXT_PUBLIC_VERCEL_ENV === "production"
              ? "production"
              : "test";
          const plan = PLANS.find(
            (plan) =>
              plan.price.monthly.priceIds[env] === newPriceId ||
              plan.price.yearly.priceIds[env] === newPriceId,
          );
          const usageLimit = plan.quota;
          const stripeId = subscriptionUpdated.customer.toString();

          // If a project upgrades/downgrades their subscription, update their usage limit in the database.
          await prisma.project.update({
            where: {
              stripeId,
            },
            data: {
              usageLimit,
              plan: plan.slug,
            },
          });
        } else if (event.type === "customer.subscription.deleted") {
          const subscriptionDeleted = event.data.object as Stripe.Subscription;

          const stripeId = subscriptionDeleted.customer.toString();

          // If a project deletes their subscription, reset their usage limit in the database to 1000.
          // Also remove the root domain redirect for all their domains from Redis.
          const project = await prisma.project.findUnique({
            where: {
              stripeId,
            },
            select: {
              name: true,
              domains: true,
            },
          });

          const projectDomains = project.domains.map((domain) => domain.slug);

          const pipeline = redis.pipeline();
          // remove root domain redirect for all domains
          projectDomains.forEach((domain) => {
            pipeline.del(`root:${domain}`);
          });

          const response = await Promise.all([
            prisma.project.update({
              where: {
                stripeId,
              },
              data: {
                usageLimit: 1000,
                plan: "free",
              },
            }),
            pipeline.exec(),
            log(
              ":cry: Project *`" + name + "`* deleted their subscription",
              "links",
            ),
          ]);
          console.log(response);
        } else {
          throw new Error("Unhandled relevant event!");
        }
      } catch (error) {
        console.log(error);
        return res
          .status(400)
          .send('Webhook error: "Webhook handler failed. View logs."');
      }
    } else {
      return res.status(400).send(`🤷‍♀️ Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } else {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
}
