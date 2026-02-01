# Cloudflare AI Feedback Insights

This project is a lightweight prototype of an AI-powered feedback insights agent built using Cloudflare products.  
Its goal is to automatically transform raw product feedback into structured, decision-ready insights.

The agent generates:
- Separate **positive** and **negative summaries**
- **Keywords/themes** that capture recurring user sentiment

All insights are visualized through a minimal UI and exposed via API endpoints.

---

## Demo

Live prototype deployed on Cloudflare Workers:

https://twilight-dew-e9d1.javiera-prenafeta.workers.dev

---

## Architecture Overview

The prototype uses a fully serverless, API-first architecture on Cloudflare:

- **Cloudflare Workers**  
  Acts as the core execution and orchestration layer. Workers handle request routing, API endpoints, AI inference orchestration, and serve a lightweight UI for visualization.

- **Cloudflare D1**  
  Used as a lightweight SQL database to store a dummy feedback dataset created exclusively for prototyping purposes. The data simulates realistic product feedback without relying on real users or sensitive data.

- **Cloudflare Workers AI**  
  Powers the AI agent. Feedback retrieved from D1 is analyzed using Workers AI to generate structured insights (positive summary, negative summary, and keywords). JSON schema enforcement and fallback logic are implemented to ensure reliability.

---

## API Endpoints

- `/health`  
  Returns service status.

- `/api/products`  
  Lists available products from the database.

- `/api/feedback?product=workers`  
  Returns raw feedback for a selected product.

- `/api/insights?product=workers`  
  Generates AI-powered insights for the selected product.

---

## Intended User Experience

1. A user selects a product (or views all products).
2. Relevant feedback is retrieved from D1.
3. Workers AI generates:
   - What is working well (positive insights)
   - What is not working well (negative insights)
   - Keywords summarizing each side
4. Insights are displayed separately to make patterns easy to understand at a glance.

---

## Notes on Scope

This prototype was intentionally scoped to fit a short development timeframe.  
Additional features such as filtering insights by source (e.g., email vs Discord) or drilling down from keywords to underlying comments were considered but left out of scope to focus on demonstrating core product value.

---

## Technologies Used

- Cloudflare Workers
- Cloudflare D1
- Cloudflare Workers AI
