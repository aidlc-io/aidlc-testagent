# Requirement — Checkout (SauceDemo)

The checkout flow lets an authenticated shopper buy the items in their cart.

## Intended behavior

1. **Add to cart.** From the inventory page, a shopper can add one or more
   products to the cart. The cart badge reflects the number of items.
2. **Review cart.** The cart page lists every added item with its name and price.
3. **Enter information.** Checkout step one requires first name, last name, and
   postal code. Missing any field shows an error and blocks progress.
4. **Review totals.** Checkout step two shows the item total, tax, and a final
   total that equals item total + tax.
5. **Complete order.** Finishing checkout shows a confirmation ("Thank you for
   your order!") and empties the cart.

## Edge / negative cases (intent the manual tests must verify)

- Submitting step one with an empty postal code is rejected with a visible error.
- The final total must equal the sum of item prices plus tax (no rounding drift).
