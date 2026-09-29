# Markdown math preview smoke test

Inline math: $x^2+y^2=z^2$ and $\alpha+\beta$ should render as formulas.

Display math:

$$
\int_0^1 x^2\,dx=\frac{1}{3}
$$

The table must keep exactly three columns. The two vertical bars around $|D|$
belong to the formula in the middle cell.

| Sample | Formula | Note |
| --- | --- | --- |
| Cardinality | $|D|=3$ | One middle cell |
| Conditional | $p(x\mid y)$ | No extra columns |

Currency stays text: $5 and $10; a range from $5-$10.

Code stays source: `$x^2$`.

Bold in a paragraph: **strong text** and **加粗文字** should have visibly heavier strokes.

Bold in a table cell:

| Sample | Emphasis |
| --- | --- |
| Strong | **加粗文字** |

Bold code: **`identifier`** should remain monospace and appear bold.
