--[[
  free_agent_capacity.lua
  Decrements an agent's active load, recalculates their composite routing score
  across all their registered skill ZSETs, and re-adds them to the active candidate pools.

  KEYS[1]: agent load key (tenant:{tenantId}:agent:{agentId}:load)
  KEYS[2]: agent info key (tenant:{tenantId}:agent:{agentId}:info)
  ARGV[1]: tenantId
  ARGV[2]: agentId
--]]

local loadKey = KEYS[1]
local infoKey = KEYS[2]
local tenantId = ARGV[1]
local agentId = ARGV[2]

local currentLoad = tonumber(redis.call('GET', loadKey)) or 0
local newLoad = currentLoad - 1
if newLoad < 0 then
    newLoad = 0
end
redis.call('SET', loadKey, newLoad)

local status = redis.call('HGET', infoKey, 'status')
local maxCapacityStr = redis.call('HGET', infoKey, 'max_capacity')
local maxCapacity = tonumber(maxCapacityStr) or 5

if status == 'ONLINE' then
    local allSkillsStr = redis.call('HGET', infoKey, 'all_skills')
    if allSkillsStr then
        for s in string.gmatch(allSkillsStr, "([^,]+)") do
            local zsetKey = 'tenant:' .. tenantId .. ':skill:' .. s .. ':agents'
            local profStr = redis.call('HGET', infoKey, 'prof:' .. s)
            local prof = tonumber(profStr) or 1
            local availableRatio = (maxCapacity - newLoad) / maxCapacity
            local score = (prof * 100) + (availableRatio * 50)
            redis.call('ZADD', zsetKey, score, agentId)
        end
    end
end

return newLoad
