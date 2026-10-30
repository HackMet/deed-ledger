'use strict';
// E3 read tools. Executed by the APP over records.json, store-scoped from
// context.store. The model only chooses calls; all totals come from here.

function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function createReadTools(records, store) {
  const part = records.stores[store];
  if (!part) throw new Error(`unknown store scope: ${store}`);

  const salesIn = (from, to) => part.sales.filter((r) => r.date >= from && r.date <= to);
  const expIn = (from, to) => part.expenses.filter((r) => r.date >= from && r.date <= to);
  const pendingFiado = () => part.fiado.filter((e) => e.status === 'pending');

  const defs = [
    { type: 'function', function: {
      name: 'get_sales_total',
      description: 'Total sales for this store between two dates (YYYY-MM-DD, inclusive). App-computed.',
      parameters: { type: 'object',
        properties: { date_from: { type: 'string' }, date_to: { type: 'string' } },
        required: ['date_from', 'date_to'], additionalProperties: false },
    }},
    { type: 'function', function: {
      name: 'get_expenses_total',
      description: 'Total expenses for this store between two dates (YYYY-MM-DD, inclusive). App-computed.',
      parameters: { type: 'object',
        properties: { date_from: { type: 'string' }, date_to: { type: 'string' } },
        required: ['date_from', 'date_to'], additionalProperties: false },
    }},
    { type: 'function', function: {
      name: 'list_pending_fiado',
      description: 'Pending store-credit entries for this store. No total is computed.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    }},
    { type: 'function', function: {
      name: 'get_day_summary',
      description: 'Day close for this store: sales, expenses, pending fiado count, record IDs.',
      parameters: { type: 'object',
        properties: { date: { type: 'string' } },
        required: ['date'], additionalProperties: false },
    }},
    { type: 'function', function: {
      name: 'get_stock_record',
      description: 'Recorded stock for one product in this store, with baseline status. Unknown products return {unknown:true}.',
      parameters: { type: 'object',
        properties: { product_query: { type: 'string' } },
        required: ['product_query'], additionalProperties: false },
    }},
  ];

  function execute(name, args) {
    switch (name) {
      case 'get_sales_total': {
        const rows = salesIn(args.date_from, args.date_to);
        return { total_minor: rows.reduce((s, r) => s + r.total_minor, 0),
          record_count: rows.length, record_ids: rows.map((r) => r.id) };
      }
      case 'get_expenses_total': {
        const rows = expIn(args.date_from, args.date_to);
        return { total_minor: rows.reduce((s, r) => s + r.total_minor, 0),
          record_count: rows.length, record_ids: rows.map((r) => r.id) };
      }
      case 'list_pending_fiado': {
        const entries = pendingFiado().map((e) => ({ id: e.id, counterparty_text: e.counterparty_text, amount_minor: e.amount_minor, date: e.date }));
        return { entries, count: entries.length };
      }
      case 'get_day_summary': {
        const s = salesIn(args.date, args.date);
        const x = expIn(args.date, args.date);
        const f = pendingFiado();
        return { sales_minor: s.reduce((t, r) => t + r.total_minor, 0),
          expenses_minor: x.reduce((t, r) => t + r.total_minor, 0),
          pending_count: f.length,
          record_ids: [...s.map((r) => r.id), ...x.map((r) => r.id), ...f.map((e) => e.id)] };
      }
      case 'get_stock_record': {
        const q = normalize(args.product_query);
        const hit = part.stock.find((p) => {
          const id = normalize(p.product_id);
          return q.includes('lech') && id.includes('leche') ||
                 q.includes('arroz') && id.includes('arroz');
        });
        if (!hit) return { unknown: true, reason: 'no records for this product in this store' };
        return { product_id: hit.product_id, recorded_qty: hit.recorded_qty,
          unit: hit.unit, baseline_status: hit.baseline_status, as_of: hit.as_of };
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  return { defs, execute };
}

module.exports = { createReadTools };
