import {Chat} from '../../components/Chat'

export default function Ask() {
  return (
    <>
      <h1>Ask</h1>
      <p className="lede">
        The agent reads the dataset and the Knowledge Base through Sanity Context, and computes times with the same
        engine as the Tonight page. Every number it states is checked against the data it retrieved.
      </p>
      <Chat />
    </>
  )
}
