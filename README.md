# Youth Football Player Rating Web Application

A full-stack youth football analytics web application built with Next.js (App Router), TypeScript, and Supabase (PostgreSQL).

## Features
- **CSV Ingestion Pipeline**: Ingests, validates, deduplicates, and sanitizes match performance data.
- **Rating Engine**: Position-group-specific percentile calculations across age groups (U15 & U17) using statistical normalization.
- **Player List UI**: Search by name, filter by age group and position, and sort by percentile, name, or appearances (with unrated players pinned to the bottom).
- **Player Detail View**: Comprehensive match performance breakdown with headline stats and expandable raw match numbers.
- **Data Management Controls**:
  - **Upload CSV**: Uploads new or updated match events with merging and automatic rating recomputation.
  - **Clear Data**: Gated behind a typed confirmation (`DELETE`), allowing complete database purge in FK-safe reverse dependency order.

## Security & Architecture Note
The player list page includes a 'Clear Data' control, gated behind a typed confirmation, that deletes all data in the database. Because this assignment has no authentication layer, this is technically reachable by anyone with the URL — an accepted trade-off given the assignment's time-box, and something a production version would need to protect behind auth.

## Getting Started

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `.env.local`:
```env
NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

3. Run the development server:
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to access the application.
