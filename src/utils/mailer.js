import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function formatDate(value) {
  if (!value) return 'Not specified';
  const d = new Date(value);
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// Builds the invoice-style HTML used in the email body.
// Kept as one function so the layout is defined in exactly one place.
export function buildInvoiceHtml(r) {
  const row = (label, value) => `
    <tr>
      <td style="padding:10px 0; color:#6b7178; font-size:13px; border-bottom:1px solid #eee;">${label}</td>
      <td style="padding:10px 0; text-align:right; font-size:14px; border-bottom:1px solid #eee;">${value}</td>
    </tr>`;

  const items = r.items && r.items.length ? r.items : [{ item_name: r.item_name, quantity: r.quantity }];
  const itemRows = items
    .map(
      (i) => `
    <tr>
      <td style="padding:8px 0; font-size:14px; border-bottom:1px solid #eee;">${i.item_name}</td>
      <td style="padding:8px 0; text-align:right; font-size:14px; border-bottom:1px solid #eee;">×${i.quantity}</td>
    </tr>`
    )
    .join('');

  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; border: 1px solid #dcdad4; border-radius: 8px; overflow: hidden;">
    <div style="background: #1c2126; color: #fff; padding: 20px 24px;">
      <h2 style="margin:0; font-size: 18px;">Material Request</h2>
      <p style="margin: 4px 0 0; color: #b7bac1; font-size: 13px;">Request #${r.request_id ?? ''}</p>
    </div>
    <div style="padding: 24px;">
      <table style="width:100%; border-collapse: collapse;">
        ${row('Requested by', r.requester_name)}
        ${row('Requester email', r.requester_email)}
        ${row('Needed by', formatDate(r.needed_by))}
        ${row('Warehouse', r.warehouse_name)}
      </table>
      <p style="color:#6b7178; font-size:12px; margin: 20px 0 6px; text-transform:uppercase; letter-spacing:0.03em;">Items</p>
      <table style="width:100%; border-collapse: collapse;">
        ${itemRows}
      </table>
      <p style="color:#6b7178; font-size:12px; margin-top:20px;">
        Reply directly to this email to reach the requester.
      </p>
    </div>
  </div>`;
}

export async function sendMaterialRequestEmail({ to, replyTo, request }) {
  const items = request.items && request.items.length ? request.items : [{ item_name: request.item_name, quantity: request.quantity }];
  const subject =
    items.length === 1
      ? `Material Request — ${items[0].item_name} (x${items[0].quantity})`
      : `Material Request — ${items[0].item_name} and ${items.length - 1} more item${items.length > 2 ? 's' : ''}`;

  await transporter.sendMail({
    from: process.env.FROM_EMAIL || process.env.SMTP_USER,
    to,
    replyTo,
    subject,
    html: buildInvoiceHtml(request),
  });
}