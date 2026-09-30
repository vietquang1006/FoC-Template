import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { decodeSeedFile, parseCsv } from '../src/seed/csv.ts'
import { rowsToSuppliers } from '../src/seed/suppliers.ts'

const SEED_FILE = path.join(import.meta.dirname, '../../data/csv/supplier-seed-data.csv')

describe('parseCsv', () => {
  it('reads quoted fields with commas and doubled quotes', () => {
    assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\n'), [['a', 'b, c', 'say "hi"']])
  })

  it('handles CRLF line ends and drops blank lines', () => {
    assert.deepEqual(parseCsv('a,b\r\n\r\nc,d\r\n'), [
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('keeps empty trailing fields', () => {
    assert.deepEqual(parseCsv('a,b,\n'), [['a', 'b', '']])
  })
})

describe('the seed file', async () => {
  const bytes = await readFile(SEED_FILE)
  const { suppliers, warnings } = rowsToSuppliers(parseCsv(decodeSeedFile(bytes)))
  const byName = (name: string) => suppliers.find((s) => s.name === name)!

  it('yields one supplier per row', () => {
    assert.equal(suppliers.length, 21)
  })

  it('knows the zone of every building', () => {
    assert.deepEqual(warnings, [])
    assert.equal(suppliers.filter((s) => s.zone === 'Other').length, 0)
  })

  it('reads the apostrophe in Prince George\'s Park correctly', () => {
    const park = suppliers.filter((s) => s.building === "Prince George's Park")
    assert.equal(park.length, 3)
    assert.ok(suppliers.every((s) => !s.building.includes('�')))
  })

  it('joins the two spellings of COM2', () => {
    assert.equal(byName('Printer @ Com 2').building, 'COM2')
    assert.equal(byName('Cool Spot').building, 'COM2')
  })

  it('takes the type exactly as the file writes it', () => {
    const counts: Record<string, number> = {}
    for (const s of suppliers) counts[s.type] = (counts[s.type] ?? 0) + 1
    assert.deepEqual(counts, { Food: 11, 'Food/Coffee': 5, Shopping: 3, Printing: 2 })
    assert.equal(byName('TOMORO COFFEE').type, 'Food/Coffee')
    assert.equal(byName('NUS Co-op').type, 'Shopping')
    assert.deepEqual(
      suppliers.filter((s) => s.type === 'Printing').map((s) => s.name).sort(),
      ['Goh Bros E-Print Pte Ltd', 'Printer @ Com 2'],
    )
  })

  it('keeps a description that contains a comma', () => {
    assert.equal(
      byName('Supersnacks').description,
      "At level 1 in Prince George's Park Residences, Block 10",
    )
  })

  it('gives every supplier the same hours on all seven days', () => {
    const anna = byName("Anna's x Soup Union")
    assert.equal(anna.hours.length, 7)
    assert.ok(anna.hours.every((h) => h.opens === 540 && h.closes === 1080))
  })

  it('reads 0000hrs to 2359hrs as open around the clock', () => {
    assert.ok(byName('InstaChef').hours.every((h) => h.opens === 0 && h.closes === 1440))
  })

  it('keeps a closing time after midnight', () => {
    assert.ok(byName('Supersnacks').hours.every((h) => h.opens === 660 && h.closes === 120))
  })

  it('composes the address from the building and floor', () => {
    assert.equal(byName('Smooy').address, 'COM3, Level 1')
  })

  it('leaves contact details empty and every supplier active', () => {
    assert.ok(suppliers.every((s) => s.phone === null && s.email === null && s.status === 'Active'))
  })
})

describe('rowsToSuppliers', () => {
  const header = 'Name,Type,Building,Floor,Location Description,Latitude,Longitude,StartingTime,ClosingTime'

  it('fails loudly when a column is missing', () => {
    assert.throws(() => rowsToSuppliers(parseCsv('Name,Type\nx,y\n')), /missing columns/)
  })

  it('fails loudly on a row it cannot read, naming the line', () => {
    const csv = `${header}\nCafe,Food,COM3,1,,1.29,103.77,9am,1800hrs\n`
    assert.throws(() => rowsToSuppliers(parseCsv(csv)), /line 2.*opening times/)
  })

  it('warns instead of failing for a building it has no zone for', () => {
    const csv = `${header}\nCafe,Food,New Block,1,,1.29,103.77,0900hrs,1800hrs\n`
    const { suppliers, warnings } = rowsToSuppliers(parseCsv(csv))
    assert.equal(suppliers[0]!.zone, 'Other')
    assert.equal(warnings.length, 1)
  })
})
