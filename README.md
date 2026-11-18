# Apex Pulse

Uptime checks for everything you run, plus the keep-alive that stops free databases going
quiet.

**Status: the machinery exists. The dashboard does not.**

## What already exists

`Automation` has a cron scheduler (`src/agent/scheduler.ts`, a Durable Object) firing every
five minutes, and `src/agent/cron.ts` running due jobs. It is committed but **not deployed**.

That is exactly what Pulse needs: a cheap job every five minutes that pings each endpoint,
records the result, and shouts when something is down.

## Why the keep-alive matters

A Supabase free project **pauses after a week of low activity**. When it pauses, every app
built on it stops working, and it does not wake itself up. "A few user requests a day" is
enough to keep it awake, which is precisely what a five-minute ping provides.

The same trick does not apply to Firebase (no pausing) or to B2 (no pausing).

## What it should do

- A list of endpoints with a status dot and last-checked time.
- History, so you can see that something has failed every night for a week.
- An alert you actually see — email through Gmail, since you already have that connected.

## What you need to do

1. Deploy `Automation` so the cron exists.
2. Re-save the AI keys and the B2 secrets after deploying.

## First three steps

1. Store the endpoint list in Firestore.
2. One cron job that fetches each one and writes a result.
3. A single page showing green/red and the time of the last check.
