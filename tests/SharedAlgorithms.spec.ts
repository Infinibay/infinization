/**
 * SharedAlgorithms.spec.ts — behavioral coverage for the pure NUMA pinning
 * algorithms plus a DRIFT-GUARD that asserts the library copy and the backend
 * copy export an identical function set (audit M21 / L114).
 *
 * NOTE ON THE DRIFT GUARD: the two copies were previously diverged (the backend
 * copy exported `normalizeObjectTopology` and `formatCpuRanges`, which the
 * library copy lacked — a 62-line divergence the audit flagged). Those two
 * functions have now been copied VERBATIM into the library copy, so the two
 * exported surfaces are RECONCILED. The parity assertion below is therefore a
 * normal `it(...)` (no longer `it.failing`) and turns RED the moment the copies
 * drift again — making any future drift impossible to merge silently.
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  calculateBasicPinning,
  calculateHybridPinning,
  normalizeMapTopology,
  normalizeObjectTopology,
  formatCpuRanges,
  SeededRandom
} from '../src/cpu/SharedAlgorithms'

const LIB_PATH = path.resolve(__dirname, '../src/cpu/SharedAlgorithms.ts')
const BACKEND_PATH = path.resolve(
  __dirname,
  '../../backend/app/utils/VirtManager/CpuPinning/SharedAlgorithms.ts'
)

/** Extracts the set of top-level exported function/class names from TS source. */
function exportedSymbols (src: string): Set<string> {
  const names = new Set<string>()
  const re = /^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_]+)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) names.add(m[1])
  return names
}

// ---------------------------------------------------------------------------
// calculateBasicPinning
// ---------------------------------------------------------------------------

describe('calculateBasicPinning', () => {
  it('distributes vCPUs across two nodes proportionally', () => {
    const topo = normalizeMapTopology(new Map([[0, [0, 1]], [1, [2, 3]]]))
    const r = calculateBasicPinning(4, topo)
    expect(r.selectedCores).toEqual([0, 1, 2, 3])
    expect(r.usedNodes).toEqual([0, 1])
    expect(r.vcpuToCoreMapping.size).toBe(4)
  })

  it('keeps a small vCPU count on the first node (locality)', () => {
    const topo = normalizeMapTopology(new Map([[0, [0, 1, 2, 3]], [1, [4, 5, 6, 7]]]))
    const r = calculateBasicPinning(2, topo)
    // 2 of 8 cpus -> node0 gets floor(4/8*2)=1, node1 (last) gets remainder 1.
    expect(r.selectedCores.length).toBe(2)
    expect(r.usedNodes).toEqual([0, 1])
  })

  it('wraps around physical cores on overcommit (more vCPUs than cores)', () => {
    const topo = normalizeMapTopology(new Map([[0, [0, 1]]]))
    const r = calculateBasicPinning(5, topo)
    // Only cores 0,1 exist; selectedCores is the deduped set.
    expect(r.selectedCores).toEqual([0, 1])
    // All 5 vCPUs are mapped, wrapping over the 2 cores.
    expect(r.vcpuToCoreMapping.size).toBe(5)
    expect(r.vcpuToCoreMapping.get(0)).toBe(0)
    expect(r.vcpuToCoreMapping.get(1)).toBe(1)
    expect(r.vcpuToCoreMapping.get(2)).toBe(0)
    expect(r.vcpuToCoreMapping.get(4)).toBe(0)
  })

  it('returns an empty allocation for 0 vCPUs or empty topology', () => {
    const topo = normalizeMapTopology(new Map([[0, [0, 1]]]))
    expect(calculateBasicPinning(0, topo).selectedCores).toEqual([])
    expect(calculateBasicPinning(2, normalizeMapTopology(new Map())).selectedCores).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// calculateHybridPinning
// ---------------------------------------------------------------------------

describe('calculateHybridPinning', () => {
  it('selects exactly vcpuCount distinct cores when not overcommitted', () => {
    const topo = normalizeMapTopology(new Map([[0, [0, 1]], [1, [2, 3]]]))
    const r = calculateHybridPinning(3, topo, { seed: 12345 })
    expect(r.selectedCores.length).toBe(3)
    expect(new Set(r.selectedCores).size).toBe(3)
    r.selectedCores.forEach(c => expect([0, 1, 2, 3]).toContain(c))
  })

  it('is DETERMINISTIC for a fixed seed', () => {
    const topo = normalizeMapTopology(new Map([[0, [0, 1, 2, 3]], [1, [4, 5, 6, 7]]]))
    const a = calculateHybridPinning(4, topo, { seed: 99 })
    const b = calculateHybridPinning(4, topo, { seed: 99 })
    expect(a.selectedCores).toEqual(b.selectedCores)
    expect(Array.from(a.vcpuToCoreMapping.entries()))
      .toEqual(Array.from(b.vcpuToCoreMapping.entries()))
  })

  it('produces different orderings for different seeds (with high probability)', () => {
    const topo = normalizeMapTopology(new Map([[0, [0, 1, 2, 3, 4, 5, 6, 7]]]))
    const a = calculateHybridPinning(8, topo, { seed: 1 })
    const b = calculateHybridPinning(8, topo, { seed: 2 })
    // Same SET of cores (all 8), but the vcpu->core mapping order should differ.
    const mapA = Array.from(a.vcpuToCoreMapping.values()).join(',')
    const mapB = Array.from(b.vcpuToCoreMapping.values()).join(',')
    expect(mapA).not.toEqual(mapB)
  })

  it('handles overcommit wrap-around using all cores', () => {
    const topo = normalizeMapTopology(new Map([[0, [0, 1]], [1, [2, 3]]]))
    const r = calculateHybridPinning(6, topo, { seed: 7 })
    expect(r.selectedCores).toEqual([0, 1, 2, 3]) // all cores used
    expect(r.vcpuToCoreMapping.size).toBe(6)
    expect(r.usedNodes).toEqual([0, 1])
  })
})

// ---------------------------------------------------------------------------
// SeededRandom determinism
// ---------------------------------------------------------------------------

describe('SeededRandom', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new SeededRandom(42)
    const b = new SeededRandom(42)
    const seqA = [a.next(), a.next(), a.next()]
    const seqB = [b.next(), b.next(), b.next()]
    expect(seqA).toEqual(seqB)
  })

  it('nextInt stays within [0, max)', () => {
    const rng = new SeededRandom(123)
    for (let i = 0; i < 100; i++) {
      const v = rng.nextInt(5)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(5)
    }
  })
})

// ---------------------------------------------------------------------------
// DRIFT GUARD — lib copy vs backend copy export parity
// ---------------------------------------------------------------------------

describe('SharedAlgorithms drift guard (lib vs backend copy)', () => {
  it('the backend copy exists at the expected path', () => {
    expect(fs.existsSync(BACKEND_PATH)).toBe(true)
  })

  // The two copies are now RECONCILED (normalizeObjectTopology + formatCpuRanges
  // were copied verbatim into the library copy). This asserts PARITY and turns
  // RED the moment either copy grows/loses an export the other lacks.
  it('lib and backend export an identical function/class set', () => {
    const libSrc = fs.readFileSync(LIB_PATH, 'utf8')
    const backendSrc = fs.readFileSync(BACKEND_PATH, 'utf8')
    const libSyms = Array.from(exportedSymbols(libSrc)).sort()
    const backendSyms = Array.from(exportedSymbols(backendSrc)).sort()
    expect(libSyms).toEqual(backendSyms)
  })

  it('reports ZERO divergence in either direction', () => {
    const libSyms = exportedSymbols(fs.readFileSync(LIB_PATH, 'utf8'))
    const backendSyms = exportedSymbols(fs.readFileSync(BACKEND_PATH, 'utf8'))
    const onlyInBackend = Array.from(backendSyms).filter(s => !libSyms.has(s)).sort()
    const onlyInLib = Array.from(libSyms).filter(s => !backendSyms.has(s)).sort()
    // Both copies export the same set now; any future drift makes one of these
    // arrays non-empty and fails this assertion loudly.
    expect({ onlyInBackend, onlyInLib }).toEqual({
      onlyInBackend: [],
      onlyInLib: []
    })
  })
})

// ---------------------------------------------------------------------------
// normalizeObjectTopology (newly reconciled with backend copy)
// ---------------------------------------------------------------------------

describe('normalizeObjectTopology', () => {
  it('converts sysfs-style node objects to a number-keyed Map', () => {
    const t = normalizeObjectTopology({ node0: ['0', '1', '2', '3'], node1: ['4', '5', '6', '7'] })
    expect(t.totalCpus).toBe(8)
    expect(t.nodes.get(0)).toEqual([0, 1, 2, 3])
    expect(t.nodes.get(1)).toEqual([4, 5, 6, 7])
  })

  it('skips keys without a numeric node id and drops non-numeric cpus', () => {
    const t = normalizeObjectTopology({ node0: ['0', 'x', '2'], bogus: ['9'] })
    expect(Array.from(t.nodes.keys())).toEqual([0])
    expect(t.nodes.get(0)).toEqual([0, 2])
    expect(t.totalCpus).toBe(2)
  })

  it('feeds calculateBasicPinning identically to a Map-built topology', () => {
    const fromObj = normalizeObjectTopology({ node0: ['0', '1'], node1: ['2', '3'] })
    const fromMap = normalizeMapTopology(new Map([[0, [0, 1]], [1, [2, 3]]]))
    expect(calculateBasicPinning(4, fromObj).selectedCores)
      .toEqual(calculateBasicPinning(4, fromMap).selectedCores)
  })
})

// ---------------------------------------------------------------------------
// formatCpuRanges (newly reconciled with backend copy)
// ---------------------------------------------------------------------------

describe('formatCpuRanges', () => {
  it('collapses contiguous runs into ranges', () => {
    expect(formatCpuRanges([0, 1, 2, 3, 5, 7, 8, 9])).toBe('0-3,5,7-9')
  })

  it('handles empty, single, and unsorted inputs', () => {
    expect(formatCpuRanges([])).toBe('')
    expect(formatCpuRanges([4])).toBe('4')
    expect(formatCpuRanges([3, 1, 2, 0])).toBe('0-3')
  })
})
