import fs from 'node:fs/promises'
import path from 'node:path'

const PLANS_DIR = path.join(process.cwd(), '.tegent', 'plans')

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatTimestamp(now: Date = new Date()): string {
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

export function makePlanFilePath(taskText: string, opts?: { slug?: string; now?: Date }): string {
  const slug = opts?.slug ?? slugify(taskText)
  const now = opts?.now ?? new Date()
  const name = slug ? `${slug}-${formatTimestamp(now)}` : formatTimestamp(now)
  return path.join(PLANS_DIR, `${name}.md`)
}

export async function ensurePlanDir(): Promise<void> {
  await fs.mkdir(PLANS_DIR, { recursive: true })
}

export async function readPlan(planPath: string): Promise<string> {
  try {
    return await fs.readFile(planPath, 'utf-8')
  } catch {
    return ''
  }
}

export async function writePlan(planPath: string, body: string): Promise<string> {
  await ensurePlanDir()
  await fs.writeFile(planPath, body, 'utf-8')
  return planPath
}
