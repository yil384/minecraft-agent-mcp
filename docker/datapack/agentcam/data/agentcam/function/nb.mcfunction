# one block of the evidence (agentcam:note), where this runs: "." open, "L" leaves, "#" anything else
execute if block ~ ~ ~ #agentcam:open run return run data modify storage agentcam:spot tmp append value "."
execute if block ~ ~ ~ #minecraft:leaves run return run data modify storage agentcam:spot tmp append value "L"
data modify storage agentcam:spot tmp append value "#"
