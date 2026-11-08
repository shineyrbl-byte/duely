// Currencies the PayPal Invoicing API accepts for cross-border invoices.
// INR is not on the list: PayPal stopped domestic payments in India in 2021,
// so Indian accounts bill international clients in one of these instead.
export const PAYPAL_CURRENCIES = [
  "USD", "EUR", "GBP", "AUD", "CAD", "SGD", "JPY", "CHF", "HKD", "NZD", "SEK", "NOK",
  "DKK", "PLN", "CZK", "HUF", "ILS", "MXN", "BRL", "MYR", "PHP", "THB", "TWD", "CNY",
] as const;

export const isPayPalCurrency = (code: string) => (PAYPAL_CURRENCIES as readonly string[]).includes(code.toUpperCase());
