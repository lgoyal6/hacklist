export default function How() {
  return (
    <>
      <h1>How it works</h1>
      <ol className="lede">
        <li><strong>Constraints are documents.</strong> &ldquo;No e&rdquo;, &ldquo;5-7-5&rdquo;, &ldquo;never write utilize&rdquo;: each has a kind, parameters and a version.</li>
        <li><strong>Poems reference the constraints they keep.</strong> One rule can be shared by many poems, so its blast radius is a GROQ query: <code>*[_type == &quot;poem&quot; &amp;&amp; references($rule)]</code>.</li>
        <li><strong>One checker everywhere.</strong> The Studio input highlights with it as you type, the publish button refuses with it, this page previews with it, and the Sanity Function enforces with it.</li>
        <li><strong>A Sanity Function re-checks on change.</strong> It fires only when a rule&apos;s parameters change (a GROQ delta filter), bumps the rule&apos;s version, writes one verdict per poem, and logs which poems broke or recovered.</li>
        <li><strong>A workflow models the process.</strong> Drafting, an automatic check, an editor&apos;s review, published, and violated. The function ticks each affected poem&apos;s workflow, so a published poem moves to violated by itself when a rule tightens, and back when it loosens.</li>
        <li><strong>An App SDK console</strong> in the Sanity Dashboard gives editors the blast radius of every rule, live.</li>
      </ol>
      <h2>What is enforced, honestly</h2>
      <p className="lede">
        Workflow guards are advisory in Sanity today. The rule is enforced by the function (which writes the verdict and
        status) and by the publish button (which refuses a broken poem). The workflow records the process and moves with it.
      </p>
    </>
  )
}
