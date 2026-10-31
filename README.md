# Walmart Smart Cart Builder

A userscript for [Violentmonkey](https://violentmonkey.github.io/) (also works in Tampermonkey) that turns a plain shopping list into a Walmart cart.

**[Install](https://raw.githubusercontent.com/ZodchiSama/walmart-smart-cart-builder/main/walmart-smart-cart-builder.user.js)** — opening this link with Violentmonkey installed shows the install screen. Updates are picked up automatically.

## What it does

1. Click **🛒 Cart Builder** on walmart.com and write your list, one item per line.
2. **Find items** searches Walmart for each line and picks the best match, weighing name match, price, price per oz/ct, rating and popularity.
3. Review the picks. Each line has a dropdown of alternatives, and the panel shows three totals: items only, with fees for non-members, and with Walmart+.
4. **Add to cart** adds everything for you, then opens your cart. It never checks out.

### Features

- **Rollbacks and sales first:** Rollback, Clearance, Reduced price and sale items are boosted and labeled with the discount (e.g. `🔻 Rollback −10% (was $9.97)`).
- **Spelling fixes:** misspelled items still find what you meant ("bananna" → banana, "chedar chese" → cheddar cheese), and the fix is written back into your list.
- **Remembers your picks:** if you choose a different product, it becomes "your usual" for that line.
- **Pick strategies:** Smart balance, Best deal, Cheapest, Best unit price or Best rated, plus an optional store-brand preference.
- **Saved lists:** keep named lists like "Weekly groceries" and reuse them.
- **Cost estimate:** delivery, pickup or shipping fees, with Walmart+ and without. Fee amounts can be edited in Settings.

## List syntax

```
2 whole milk gallon        quantity 2 (or "milk x2")
eggs 18 ct @5              don't pay more than $5
greek yogurt -vanilla x4   leave out anything with "vanilla"
sparkling water !lacroix   must be this brand
# a comment                ignored
```

Sizes like `18 ct` or `12 pack` are read as part of the product, not as a quantity.

## Notes

- If Walmart shows its "Robot or human?" check, the script pauses. Complete it yourself, then press **Resume**.
- Products that need a size or flavor choice may need to be added by hand. They're flagged with a link.
- Fee estimates don't include tax, tip or express fees.

## License

[MIT](LICENSE). This is an unofficial tool and is not affiliated with or endorsed by Walmart.
