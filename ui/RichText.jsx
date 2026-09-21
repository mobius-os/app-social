import { previewFor, textParts } from '../links.js'

export default function RichText({ text, className, preview = false }) {
  const card = preview ? previewFor(text) : null
  return (
    <>
      <p className={className}>
        {textParts(text).map((part, index) => part.type === 'link' ? (
          <a key={`${part.value}-${index}`} href={part.value} target="_blank"
             rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>
            {part.value}
          </a>
        ) : <span key={index}>{part.value}</span>)}
      </p>
      {card && (
        <a className="cn-link-preview" href={card.url} target="_blank" rel="noopener noreferrer"
           onClick={(event) => event.stopPropagation()}>
          <span className="cn-link-preview-mark" aria-hidden="true">↗</span>
          <span className="cn-link-preview-copy">
            <strong>{card.label}</strong>
            <span>{card.detail}</span>
          </span>
        </a>
      )}
    </>
  )
}
