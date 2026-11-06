# Unknown syntax must survive

MDX-ish component:

<Callout type="warning">
  Not executed, just text.
</Callout>

Template braces: {{ title }} and {% include "x" %}

Wikilinks: [[Another note]] and [[Note|alias]]

Directives:

::: warning
Admonition syntax from another tool.
:::

Badly formed markdown (kept as-is):

**unclosed bold

[unclosed link](

| broken | table
| no delimiter row

Footnote-ish: [^1] with no definition.

^[inline footnote]

Emoji :smile: shortcode.

Setext heading
==============

Trailing spaces and tabs:   	
