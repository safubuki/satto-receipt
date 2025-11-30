type ProgressCallback = (progress: number) => void

export const runOcr = async (
  file: File,
  onProgress?: ProgressCallback,
): Promise<string> => {
  const { recognize } = await import('tesseract.js')

  const result = await recognize(file, 'jpn+eng', {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress?.(m.progress)
      }
    },
  })

  return result.data.text
}
