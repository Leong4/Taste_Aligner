type ImagePageProps = {
  imageUrl: string | null
  onImageChange: (file: File | null) => void
}

export default function ImagePage({ imageUrl, onImageChange }: ImagePageProps) {
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    onImageChange(file)
  }

  return (
    <section className="panel">
      <h2>Memory anchor</h2>
      <p className="muted">Select a local image to preview (no upload yet).</p>
      <label className="upload">
        <input type="file" accept="image/*" onChange={handleFileChange} />
        <span>Choose image</span>
      </label>
      <div className="image-preview">
        {imageUrl ? (
          <img src={imageUrl} alt="Selected preview" />
        ) : (
          <div className="image-placeholder">No image selected</div>
        )}
      </div>
    </section>
  )
}
