import { add } from './math.mjs'

if (add(2, 3) !== 5) {
  console.error('add(2, 3) should equal 5')
  process.exit(1)
}

console.log('ok')
