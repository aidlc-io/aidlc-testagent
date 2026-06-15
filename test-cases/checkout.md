# Manual test cases — Checkout (SauceDemo)

These are the human oracle for what to verify. The agent should cover them.

## TC-1: Happy-path checkout
1. Log in.
2. Add "Sauce Labs Backpack" to the cart.
3. Open the cart; confirm the backpack is listed.
4. Checkout → enter First "Test", Last "User", Postal "12345" → Continue.
5. On the overview, confirm Total = Item total + Tax.
6. Finish → expect "Thank you for your order!".

## TC-2: Missing postal code is rejected
1. Log in, add any item, go to checkout step one.
2. Enter First and Last name but leave Postal code blank → Continue.
3. Expect a visible error and that the flow does NOT advance.

## TC-3: Cart badge reflects item count
1. Log in.
2. Add two different products.
3. Expect the cart badge to show "2".
