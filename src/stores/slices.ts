import { computed, ref } from "vue"
import { defineStore, acceptHMRUpdate } from "pinia"
import { useMessages } from "@/stores/messages"
import { sumChannels, trimSilence, combineAudio } from "@/audio-tools"

export interface AudioFile {
  id: string
  name: string
  originalAudio: AudioBuffer
  audio: AudioBuffer
}

export interface Slice extends AudioFile {
  layers: AudioFile[]
}

export type TrimOption = "none" | "start" | "end" | "both"

const maxSlices = 48
const maxDuration = 45 // seconds
const maxLayers = 12

function displayName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "")
}

class Mutex {
  private promise = Promise.resolve()

  lock() {
    let resolver: () => void
    const currentPromise = this.promise
    this.promise = new Promise<void>((resolve) => {
      resolver = () => resolve()
    })
    const unlock = currentPromise.then(() => resolver)
    return unlock
  }
}

export const useSlices = defineStore("slices", () => {
  const ctx = new AudioContext({
    latencyHint: "interactive",
    sampleRate: 44100,
  })

  const messagesStore = useMessages()
  const slices = ref<Slice[]>([])
  const editSlice = ref<Slice | null>(null)

  const sliceMutex = new Mutex()
  const layerMutex = new Mutex()

  let source: AudioBufferSourceNode | null = null

  async function loadAudio(file: File): Promise<AudioFile | undefined> {
    const name = file.name
    const buffer = await file.arrayBuffer()

    let audio: AudioBuffer
    try {
      audio = await ctx.decodeAudioData(buffer)
    } catch (e) {
      messagesStore.addMessage(
        `Rejected "${name}", invalid audio file.`,
        "error",
        { timeout: 8500 },
      )
      return
    }
    if (audio.duration > maxDuration) {
      messagesStore.addMessage(
        `Rejected "${name}", too long (>${maxDuration}s).`,
        "warning",
        { timeout: 8500 },
      )
      return
    }

    const monoAudio = await sumChannels(audio)
    return {
      id: crypto.randomUUID(),
      name: displayName(name),
      audio: monoAudio,
      originalAudio: monoAudio,
    }
  }

  async function addSlice(file: File) {
    const name = file.name

    const unlock = await sliceMutex.lock()

    try {
      if (maxSlicesReached.value) {
        messagesStore.addMessage(
          `Rejected "${name}", max. ${maxSlices} slices reached.`,
          "warning",
          { timeout: 8500 },
        )
      } else if (durationExceeded.value) {
        messagesStore.addMessage(
          `Rejected "${name}", total duration > ${maxDuration}.`,
          "warning",
          { timeout: 8500 },
        )
      } else {
        const audioFile = await loadAudio(file)
        if (audioFile) {
          slices.value.push({
            ...audioFile,
            id: crypto.randomUUID(),
            layers: [audioFile],
          })
        }
      }
    } finally {
      unlock()
    }
  }

  function moveSliceUp(slice: Slice) {
    const idx = slices.value.indexOf(slice)
    slices.value.splice(idx, 1)
    slices.value.splice(idx - 1, 0, slice)
  }

  function moveSliceDown(slice: Slice) {
    const idx = slices.value.indexOf(slice)
    slices.value.splice(idx, 1)
    slices.value.splice(idx + 1, 0, slice)
  }

  function removeSlice(slice: Slice) {
    slices.value.splice(slices.value.indexOf(slice), 1)
  }

  function setEditSlice(slice: Slice) {
    editSlice.value = slice
  }

  async function addLayer(slice: Slice, file: File) {
    const unlock = await layerMutex.lock()

    const name = file.name
    try {
      if (slice.layers.length >= maxLayers) {
        messagesStore.addMessage(
          `Rejected "${name}", max. ${maxLayers} layers reached.`,
          "warning",
          { timeout: 8500 },
        )
      } else {
        const audioFile = await loadAudio(file)
        if (audioFile) {
          slice.layers.push(audioFile)
          slice.originalAudio = await combineAudio([
            slice.audio,
            audioFile.audio,
          ])
          slice.audio = slice.originalAudio
          slice.name = slice.layers.map((layer) => layer.name).join(" + ")
        }
      }
    } finally {
      unlock()
    }
  }

  async function removeLayer(slice: Slice, layer: AudioFile) {
    const unlock = await layerMutex.lock()
    try {
      if (slice.layers.length <= 1) {
        messagesStore.addMessage(
          `Cannot remove layer, a slice must have at least one layer.`,
          "warning",
          { timeout: 8500 },
        )
      } else {
        slice.layers.splice(slice.layers.indexOf(layer), 1)
        slice.originalAudio = await combineAudio(
          slice.layers.map((layer) => layer.audio),
        )
        slice.audio = slice.originalAudio
        slice.name = slice.layers.map((layer) => layer.name).join(" + ")
      }
    } finally {
      unlock()
    }
  }

  function trimAudio(file: AudioFile, option: TrimOption) {
    if (ctx === undefined) return

    const audio = file.originalAudio
    switch (option) {
      case "none":
        file.audio = audio
        break
      case "start":
        file.audio = trimSilence(audio, ctx, true, false)
        break
      case "end":
        file.audio = trimSilence(audio, ctx, false, true)
        break
      case "both":
        file.audio = trimSilence(audio, ctx)
        break
    }
  }

  function getAudioBufferSourceNode(file: AudioFile) {
    stopPlayback()
    const { audio: buffer } = file
    source = new AudioBufferSourceNode(ctx, { buffer })
    return source
  }

  function stopPlayback() {
    source?.stop()
    source?.disconnect()
    source = null
  }

  const totalSlices = computed(() => slices.value.length)

  const maxSlicesReached = computed(() => totalSlices.value >= maxSlices)

  const totalDuration = computed(() =>
    slices.value.reduce((sum, file) => sum + file.audio.duration, 0),
  )

  const durationExceeded = computed(() => totalDuration.value > maxDuration)

  return {
    audioContext: ctx,
    slices,
    editSlice,
    addSlice,
    moveSliceUp,
    moveSliceDown,
    removeSlice,
    setEditSlice,
    addLayer,
    removeLayer,
    trimAudio,
    getAudioBufferSourceNode,
    stopPlayback,
    maxSlices,
    totalSlices,
    maxSlicesReached,
    totalDuration,
    maxDuration,
    durationExceeded,
    maxLayers,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSlices, import.meta.hot))
}
