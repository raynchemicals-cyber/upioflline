import re

with open(r'c:\Users\Rida\majorproject\mern\simulator\src\experiments.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the old block by searching for its unique start and end markers
start_marker = "if (allResults.g) {\n    let csvG = 'run,seed,maliciousId"
end_marker = "    csvFiles.g = csvG;\n  }"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker, start_idx) + len(end_marker)

if start_idx == -1:
    print("START not found")
elif end_idx == -1 + len(end_marker):
    print("END not found")
else:
    old = content[start_idx:end_idx]
    print("Found block:", repr(old[:80]))

    new_block = (
        "if (allResults.g) {\n"
        "    const g = allResults.g;\n"
        "    let csvG = 'variant,run,seed,maliciousScore,minHonestScore,falsePositives,falseNegatives,deliveryRate,meanHops,meanDelayMs,sigVerifyOverhead,sigRejects\\n';\n"
        "    for (const r of (g.ga || [])) {\n"
        "      csvG += `ga,${r.run},${r.seed},,${r.minHonestScore},${r.falsePositives},0,${r.deliveryRate},${r.meanHops},${r.meanDelayMs},${r.sigVerifyOverhead},${r.sigRejects}\\n`;\n"
        "    }\n"
        "    for (const r of (g.gb || [])) {\n"
        "      csvG += `gb,${r.run},${r.seed},${r.maliciousScores[0] ?? ''},${r.minHonestScore},${r.falsePositives},${r.falseNegatives},${r.deliveryRate},${r.meanHops},${r.meanDelayMs},${r.sigVerifyOverhead},${r.sigRejects}\\n`;\n"
        "    }\n"
        "    for (const r of (g.gc || [])) {\n"
        "      csvG += `gc,${r.run},${r.seed},${Math.min(...r.maliciousScores)},${r.minHonestScore},${r.falsePositives},${r.falseNegatives},${r.deliveryRate},${r.meanHops},${r.meanDelayMs},${r.sigVerifyOverhead},${r.sigRejects}\\n`;\n"
        "    }\n"
        "    for (const r of (g.gb_modes || [])) {\n"
        "      csvG += `gb_flood,${r.run},${r.seed},${r.flood.maliciousScores[0] ?? ''},${r.flood.minHonestScore},${r.flood.falsePositives},${r.flood.falseNegatives},${r.flood.deliveryRate},${r.flood.meanHops},${r.flood.meanDelayMs},${r.flood.sigVerifyOverhead},${r.flood.sigRejects}\\n`;\n"
        "      csvG += `gb_trust,${r.run},${r.seed},${r.trustAware.maliciousScores[0] ?? ''},${r.trustAware.minHonestScore},${r.trustAware.falsePositives},${r.trustAware.falseNegatives},${r.trustAware.deliveryRate},${r.trustAware.meanHops},${r.trustAware.meanDelayMs},${r.trustAware.sigVerifyOverhead},${r.trustAware.sigRejects}\\n`;\n"
        "    }\n"
        "    csvFiles.g = csvG;\n"
        "  }"
    )

    content = content[:start_idx] + new_block + content[end_idx:]
    with open(r'c:\Users\Rida\majorproject\mern\simulator\src\experiments.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print("OK replaced")
