# a spot for the camera while the bot is enclosed, the best first: the orbit's ring (from behind the bot, then turning
# out both ways), the nearest good spot within 8 blocks, a view from high above (through open air), a view of the place
# from outside (agentcam:far: no line to the shelter, but no wall in front of the lens); else first
# person until a spot frees up (tried again every 2 s)
tag @a[tag=agentcam_target] remove agentcam_deep
execute unless entity @e[type=minecraft:marker,tag=agentcam_orbit] at @a[tag=agentcam_target,limit=1] run summon minecraft:marker ~ ~ ~ {Tags:["agentcam_orbit"]}
execute unless entity @e[type=minecraft:marker,tag=agentcam_spot] at @a[tag=agentcam_target,limit=1] run summon minecraft:marker ~ ~ ~ {Tags:["agentcam_spot"]}
execute at @a[tag=agentcam_target,limit=1] run tp @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] ~ ~ ~
scoreboard players set #f agentcam_y 0
scoreboard players set #hold agentcam_y 0
function agentcam:ring
execute if score #f agentcam_y matches 0 run function agentcam:near
execute if score #f agentcam_y matches 0 run function agentcam:above
execute if score #f agentcam_y matches 0 run function agentcam:far
execute if score #f agentcam_y matches 0 run tag @a[tag=agentcam_target] add agentcam_deep
execute if score #f agentcam_y matches 0 run scoreboard players set #on agentcam_y 3
# the evidence (agentcam:note_new): the rule that picked the spot (1 the ring, 2 the nearest within 8 blocks, 3 from
# above, 5 the place from outside, 4 none outside: first person)
execute if score #on agentcam_y matches 1 run scoreboard players set #rl agentcam_y 1
execute if score #on agentcam_y matches 2 if score #hv agentcam_y matches 0 run scoreboard players set #rl agentcam_y 2
execute if score #on agentcam_y matches 2 if score #hv agentcam_y matches 1 run scoreboard players set #rl agentcam_y 3
execute if score #on agentcam_y matches 2 if score #hv agentcam_y matches 2 run scoreboard players set #rl agentcam_y 5
execute if score #on agentcam_y matches 3 run scoreboard players set #rl agentcam_y 4
function agentcam:note_new
