# one spot of agentcam:near: ring #np (4 out 4 up, 5.5 out 1.5 up under a canopy, 3 out 5 up, 6 out 3 up, 7 out 2 up,
# 6 out 5 up, 8 out 4 up: nearest first, each 5.4 blocks or more from the bot; 8 out 8 up and 3 out 12 up for
# agentcam:far) at #rd
function agentcam:turn
scoreboard players set #g agentcam_y 0
execute if score #np agentcam_y matches 1 as @a[tag=agentcam_target,limit=1] at @s rotated as @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] rotated ~ 0 positioned ^ ^4 ^-4 run function agentcam:good
execute if score #np agentcam_y matches 2 as @a[tag=agentcam_target,limit=1] at @s rotated as @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] rotated ~ 0 positioned ^ ^1.5 ^-5.5 run function agentcam:good
execute if score #np agentcam_y matches 3 as @a[tag=agentcam_target,limit=1] at @s rotated as @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] rotated ~ 0 positioned ^ ^5 ^-3 run function agentcam:good
execute if score #np agentcam_y matches 4 as @a[tag=agentcam_target,limit=1] at @s rotated as @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] rotated ~ 0 positioned ^ ^3 ^-6 run function agentcam:good
execute if score #np agentcam_y matches 5 as @a[tag=agentcam_target,limit=1] at @s rotated as @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] rotated ~ 0 positioned ^ ^2 ^-7 run function agentcam:good
execute if score #np agentcam_y matches 6 as @a[tag=agentcam_target,limit=1] at @s rotated as @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] rotated ~ 0 positioned ^ ^5 ^-6 run function agentcam:good
execute if score #np agentcam_y matches 7 as @a[tag=agentcam_target,limit=1] at @s rotated as @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] rotated ~ 0 positioned ^ ^4 ^-8 run function agentcam:good
execute if score #np agentcam_y matches 8 as @a[tag=agentcam_target,limit=1] at @s rotated as @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] rotated ~ 0 positioned ^ ^8 ^-8 run function agentcam:good_far
execute if score #np agentcam_y matches 9 as @a[tag=agentcam_target,limit=1] at @s rotated as @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] rotated ~ 0 positioned ^ ^12 ^-3 run function agentcam:good_far
execute if score #g agentcam_y matches 1 run function agentcam:to_spot
execute if score #g agentcam_y matches 1 run scoreboard players set #f agentcam_y 1
